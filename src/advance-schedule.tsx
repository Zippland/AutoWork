import { useEffect, useState } from "react";
import type { Snapshot } from "../core";

type ScheduleProps = {
  research: Snapshot["research"];
  paused: boolean;
  connected: boolean;
  running: boolean;
  queued: boolean;
  unavailable?: string;
};

export function describeAdvanceSchedule({ research, paused, connected, running, queued, unavailable }: ScheduleProps, now: number) {
  if (unavailable) return { label: "自动推进暂不可用", title: unavailable };
  if (running) return { label: "结束后安排下一轮", title: "当前正在推进，完成后重新计算下次自动推进时间。" };
  if (queued) return { label: "等待本轮开始", title: "推进已排队，完成后重新计算下次自动推进时间。" };
  if (paused) return { label: "自动推进已暂停", title: "可在设置中恢复自动推进，或随时手动推进。" };
  if (!research.daily.enabled) return { label: "未开启定时推进", title: "可在设置中开启定期查看当天变化，或随时手动推进。" };
  if (!connected) return { label: "连接 AI 后自动推进", title: "请先在设置中连接本地 AI。" };
  const blocked = research.daily.blockedReason || research.blockedReason || research.calendarError;
  if (blocked) return { label: "自动推进已暂停", title: blocked };
  const next = Date.parse(research.daily.nextAt || "");
  if (!Number.isFinite(next)) return { label: "等待下次安排", title: "尚未取得下次自动推进时间。" };
  const seconds = Math.max(0, Math.ceil((next - now) / 1000));
  const minutes = Math.ceil(seconds / 60);
  const remaining = seconds < 3600
    ? `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
    : `${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ""}`;
  const time = new Date(next).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
  return { label: seconds ? `${remaining} 后自动推进` : "等待自动推进", title: `下次自动推进：${time}（北京时间）。按设置中的工作日与时段执行；电脑唤醒且本地服务运行时生效。` };
}

export function AdvanceSchedule(props: ScheduleProps) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    // Display only: the server owns the schedule and starts each run.
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const { label, title } = describeAdvanceSchedule(props, now);
  return <span className="advance-countdown" aria-live="off" title={title}>{label}</span>;
}
