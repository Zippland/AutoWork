// @vitest-environment node
import { expect, it } from "vitest";
import { inResearchWindow, nextResearchWindow, researchCalendarError } from "./research-window";

it.each([
  ["2026-09-18T09:59:59+08:00", false],
  ["2026-09-18T10:00:00+08:00", true],
  ["2026-09-18T21:59:59+08:00", true],
  ["2026-09-18T22:00:00+08:00", false],
  ["2026-09-19T12:00:00+08:00", false],
  ["2026-09-20T12:00:00+08:00", true],
  ["2026-09-25T12:00:00+08:00", false],
  ["2026-10-01T12:00:00+08:00", false],
  ["2026-10-10T12:00:00+08:00", true],
  ["2027-01-01T12:00:00+08:00", false],
])("checks China holidays, make-up weekends and the exact window: %s", (at, allowed) => {
  expect(inResearchWindow(new Date(at))).toBe(allowed);
});

it.each([
  ["2026-09-18T01:59:59Z", "2026-09-18T02:00:00.000Z"],
  ["2026-09-18T13:59:59Z", "2026-09-18T13:59:59.000Z"],
  ["2026-09-18T14:00:00Z", "2026-09-20T02:00:00.000Z"],
  ["2026-09-24T23:00:00+08:00", "2026-09-28T02:00:00.000Z"],
  ["2026-10-01T10:00:00+08:00", "2026-10-08T02:00:00.000Z"],
  ["2026-12-31T22:00:00+08:00", null],
])("defers to one valid window without replaying a missed backlog: %s", (at, next) => {
  expect(nextResearchWindow(new Date(at))).toBe(next);
});

it("surfaces unavailable future data instead of guessing weekday-only schedules", () => {
  expect(researchCalendarError(new Date("2027-01-01T12:00:00+08:00"))).toContain("更新日历");
  expect(researchCalendarError(new Date("2026-09-19T12:00:00+08:00"))).toBeNull();
});

it("honors user-defined minute windows, weekdays and everyday without relying on the holiday calendar", () => {
  const settings = { days: "weekdays" as const, start: "09:30", end: "18:15", dailyMinutes: 45, backgroundMinutes: 1440 };
  expect(inResearchWindow(new Date("2026-09-18T09:29:59+08:00"),settings)).toBe(false);
  expect(inResearchWindow(new Date("2026-09-18T09:30:00+08:00"),settings)).toBe(true);
  expect(inResearchWindow(new Date("2026-09-18T18:15:00+08:00"),settings)).toBe(false);
  expect(inResearchWindow(new Date("2026-09-20T12:00:00+08:00"),settings)).toBe(false);
  expect(nextResearchWindow(new Date("2026-09-18T18:15:00+08:00"),settings)).toBe("2026-09-21T01:30:00.000Z");
  expect(inResearchWindow(new Date("2027-01-01T12:00:00+08:00"),{...settings,days:"everyday"})).toBe(true);
});
