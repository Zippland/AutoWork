import { expect, it } from "vitest";
import { researchSchedulesSchema } from "../core";
import { describeAdvanceSchedule } from "./advance-schedule";

const now = Date.parse("2026-09-18T13:59:00Z");
const props = {
  paused: false, connected: true, running: false, queued: false,
  research: { ...researchSchedulesSchema.parse({ daily: { nextAt: "2026-09-18T13:59:45Z" } }), calendarError: null, active: [], queued: [] },
};

it("counts down to the server's next window instead of restarting an interval on render", () => {
  expect(describeAdvanceSchedule(props, now).label).toBe("00:45 后自动推进");
  expect(describeAdvanceSchedule(props, now + 1000).label).toBe("00:44 后自动推进");
  const nextWindow = { ...props, research: { ...props.research, daily: { ...props.research.daily, nextAt: "2026-09-21T02:00:00Z" } } };
  const result = describeAdvanceSchedule(nextWindow, now);
  expect(result.label).toBe("60 小时 1 分 后自动推进");
  expect(result.title).toContain("9/21");
  expect(result.title).toContain("10:00");
  expect(result.title).toContain("北京时间");
});

it("does not promise automatic execution when paused, disabled, disconnected, blocked or already working", () => {
  expect(describeAdvanceSchedule({ ...props, paused: true }, now).label).toBe("自动推进已暂停");
  expect(describeAdvanceSchedule({ ...props, connected: false }, now).label).toBe("连接 AI 后自动推进");
  expect(describeAdvanceSchedule({ ...props, unavailable: "连接中断" }, now)).toEqual({ label: "自动推进暂不可用", title: "连接中断" });
  expect(describeAdvanceSchedule({ ...props, running: true }, now).label).toBe("结束后安排下一轮");
  expect(describeAdvanceSchedule({ ...props, queued: true }, now).label).toBe("等待本轮开始");
  for (const daily of [{ ...props.research.daily, enabled: false }, { ...props.research.daily, blockedReason: "上轮失败" }]) {
    expect(describeAdvanceSchedule({ ...props, research: { ...props.research, daily } }, now).label).not.toContain("后自动推进");
  }
});

it("shows a waiting state at the deadline without claiming a run has started", () => {
  expect(describeAdvanceSchedule(props, now + 60_000).label).toBe("等待自动推进");
  expect(describeAdvanceSchedule({ ...props, research: { ...props.research, daily: { ...props.research.daily, nextAt: null } } }, now).label).toBe("等待下次安排");
});
