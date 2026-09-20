import chineseDays from "chinese-days";
import calendar from "chinese-days/dist/chinese-days.json";
import { researchSettingsSchema, type ResearchSettings } from "./schema";
export const RESEARCH_TIME_ZONE = "Asia/Shanghai";
const years = new Set(Object.keys(calendar.holidays).map((day) => day.slice(0, 4)));
const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: RESEARCH_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function localDate(at: Date) {
  const parts = Object.fromEntries(formatter.formatToParts(at).map(({ type, value }) => [type, value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}
const defaults = researchSettingsSchema.parse({});
function allowedDay(day: string, settings: ResearchSettings) {
  if (settings.days === "everyday") return true;
  if (settings.days === "weekdays") return ![0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay());
  return years.has(day.slice(0, 4)) && chineseDays.isWorkday(day);
}
export function inResearchWindow(at: Date, settings = defaults): boolean {
  const { day, time } = localDate(at);
  return allowedDay(day, settings) && time >= settings.start && time < settings.end;
}
export function nextResearchWindow(at: Date, settings = defaults): string | null {
  let { day } = localDate(at);
  for (let count = 0; count < 370; count++) {
    if (settings.days === "china-workdays" && !years.has(day.slice(0, 4))) return null;
    const start = new Date(`${day}T${settings.start}:00+08:00`).getTime();
    const end = new Date(`${day}T${settings.end}:00+08:00`).getTime();
    if (allowedDay(day, settings) && at.getTime() < end) return new Date(Math.max(at.getTime(), start)).toISOString();
    day = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  }
  return null;
}
export function researchCalendarError(at: Date, settings = defaults): string | null {
  return nextResearchWindow(at, settings) ? null : `工作日历仅覆盖至 ${Math.max(...[...years].map(Number))} 年，请更新日历依赖后恢复自动巡检。手动刷新仍可使用。`;
}
