// @vitest-environment node
import { expect, it } from "vitest";
import {
  cardHeaderSchema,
  commandRequestSchema,
  mapKeys,
  snapshotResponseSchema,
  systemSchema,
  taskViewSchema,
} from "./schema";
it("requires only display/interaction metadata and preserves model-defined additions", () => {
  expect(
    cardHeaderSchema.parse({
      title: "发布准备",
      status: "todo",
      ownerNotes: { anything: true },
    }),
  ).toMatchObject({ request: null, ownerNotes: { anything: true } });
  expect(
    cardHeaderSchema.safeParse({ title: "", status: "todo" }).success,
  ).toBe(false);
  expect(
    cardHeaderSchema.safeParse({ title: "示例", status: "running" }).success,
  ).toBe(false);
});
it("validates user commands independently of model text and accepts wire casing", () => {
  expect(
    commandRequestSchema.parse({
      type: "chat",
      request_id: "00000000-0000-4000-8000-000000000001",
      message: "把发布相关的那件事先暂停",
    }),
  ).toHaveProperty("requestId");
  expect(
    commandRequestSchema.safeParse({ type: "approve", task_id: "PIL-1" })
      .success,
  ).toBe(false);
  expect(
    commandRequestSchema.safeParse({ type: "knowledge", action: "confirm" })
      .success,
  ).toBe(false);
});
it("round trips the current state boundary and rejects malformed snapshots", () => {
  const state = {
    onboardingCompletedAt: null,
    tasks: [],
    attention: "",
    background: { body: "", updatedAt: null },
    messages: [],
    runs: [],
    paused: false,
    busy: false,
    activeScopes: [],
    research: {
      ...systemSchema.parse({ format: 3 }).research,
      active: [],
      queued: [],
      calendarError: null,
    },
    runtime: {
      workspace: "/tmp",
      modelConnection: {
        provider: null,
        label: "未连接",
        status: "disconnected",
        verifiedAt: null,
        error: null,
        available: [],
      },
      fileIssues: [],
      error: null,
    },
  };
  expect(snapshotResponseSchema.parse(mapKeys(state, "snake"))).toEqual(state);
  expect(snapshotResponseSchema.safeParse({ tasks: "invalid" }).success).toBe(
    false,
  );
  expect(systemSchema.parse({ format: 3 }).approvals).toEqual([]);
});

it("validates both task types without guessing a responsibility for unclassified older cards", () => {
  for (const category of ["commitment", "proactive"]) {
    expect(cardHeaderSchema.parse({ title: "事项", status: "todo", category }).category).toBe(category);
  }
  expect(cardHeaderSchema.parse({ title: "旧事项", status: "done" }).category).toBeUndefined();
  expect(cardHeaderSchema.safeParse({ title: "事项", status: "todo", category: "unrelated" }).success).toBe(false);
  expect(taskViewSchema.shape.category.parse(undefined)).toBeNull();
});

it("retains legacy schedule errors as diagnostics without changing the user's switches", () => {
  const state = systemSchema.parse({ format: 3, paused: false, research: {
    daily: { enabled: true, blockedReason: "旧版超时暂停" },
    background: { enabled: false, blockedReason: "旧版错误", lastError: null },
  } });
  expect(state.paused).toBe(false);
  expect(state.research.daily).toMatchObject({ enabled: true, lastError: "旧版超时暂停" });
  expect(state.research.daily).not.toHaveProperty("blockedReason");
  expect(state.research.background).toMatchObject({ enabled: false, lastError: null });
});
