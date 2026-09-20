import { expect, it } from "vitest";
import { taskViewSchema, STATUS_LABELS } from "../core";
import { inView } from "./board";

it("separates saved feedback from accepted work in board filters and navigation counts", () => {
  const task = taskViewSchema.parse({ id: "A", title: "修改方案", status: "awaiting_ai", request: null, body: "", digest: "v1", updatedAt: "2026-09-20T02:00:00Z", files: [], error: null });
  expect(STATUS_LABELS[task.status]).toBe("待推进");
  expect(inView(task, "todo")).toBe(true);
  expect(inView(task, "review")).toBe(false);
  expect(inView(task, "progress")).toBe(false);
  for (const status of ["queued", "running", "waiting"] as const) {
    expect(inView({ ...task, status }, "progress")).toBe(true);
    expect(inView({ ...task, status }, "todo")).toBe(false);
  }
});
