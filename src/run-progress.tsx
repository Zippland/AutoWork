import { useEffect, useState } from "react";
import type { Snapshot } from "../core";

type Run = Snapshot["runs"][number];
const duration = (seconds: number) => seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;

export function describeProgress(run: Run | undefined, now: number) {
  const secondsSince = (at: string) => Math.max(0, Math.floor((now - Date.parse(at)) / 1000) || 0);
  const elapsed = run ? secondsSince(run.startedAt) : 0;
  const silence = run ? secondsSince(run.lastActivityAt || run.startedAt) : 0;
  const progress = run?.progress || "正在准备本轮资料";
  const finalOnly = progress === "AI 已启动，等待结果";
  // Older runs may have retained their initial label after the process started.
  const oldStarting = /正在启动本地\s*AI/.test(progress);
  const stage = finalOnly ? progress : silence >= 60 ? "暂未收到新的进展" : oldStarting && elapsed >= 15 ? "等待 AI 返回进展" : progress;
  const timing = run ? `已用时 ${duration(elapsed)}${!finalOnly && silence >= 15 ? ` · ${duration(silence)}未收到新进展` : ""}` : "";
  const note = finalOnly ? "此执行器只在结束时返回结果，暂时没有实时进度。" : silence >= 60 ? "可以继续等待，或停止本轮；没有新反馈不代表已经断网。" : "";
  return { stage, timing, note };
}

// This timer only updates elapsed time on screen; it never fabricates activity.
export function RunProgress({ run }: { run: Run | undefined }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const { stage, timing, note } = describeProgress(run, now);
  return <div className="run-progress-detail"><p>{stage}</p>{timing && <small aria-live="off">{timing}</small>}{note && <p className="run-progress-note">{note}</p>}</div>;
}
