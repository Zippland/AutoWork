import { expect, it } from "vitest";
import { runSchema } from "../core";
import { describeProgress } from "./run-progress";

const start = Date.parse("2026-09-18T07:30:00Z");
const run = runSchema.parse({ id: "test", scope: "frontdesk", status: "running", detail: "", startedAt: new Date(start).toISOString(), finishedAt: null });

it("does not leave an old starting label on screen when there is no new evidence", () => {
  const old = { ...run, progress: "正在启动本地 AI", lastActivityAt: run.startedAt };
  expect(describeProgress(old, start + 20_000).stage).toBe("等待 AI 返回进展");
  const silent = describeProgress(old, start + 180_000);
  expect(silent.stage).toBe("暂未收到新的进展");
  expect(silent.timing).toContain("3 分 0 秒未收到新进展");
  expect(silent.note).toContain("不代表已经断网");
  expect(old.lastActivityAt).toBe(run.startedAt);
});

it("explains result-only execution rather than pretending it emits intermediate progress", () => {
  const progress = describeProgress({ ...run, progress: "AI 已启动，等待结果" }, start + 120_000);
  expect(progress.stage).toBe("AI 已启动，等待结果");
  expect(progress.note).toContain("只在结束时返回结果");
  expect(progress.timing).toBe("已用时 2 分 0 秒");
});

it("shows a fresh real event again after a quiet period", () => {
  const fresh = { ...run, progress: "正在查看网页", lastActivityAt: new Date(start + 179_000).toISOString() };
  const progress = describeProgress(fresh, start + 180_000);
  expect(progress.stage).toBe("正在查看网页");
  expect(progress.note).toBe("");
  expect(describeProgress(undefined, start).timing).toBe("");
});
