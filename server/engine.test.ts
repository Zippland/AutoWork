// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "./store";
import { Engine } from "./engine";
import { cardFile, encodeCard, parseCard, textContent, type FileMap } from "./documents";
import { FileTurnError, type FileTurn } from "./file-agent";
import { initializeWorkspace } from "./initialize";
const roots: string[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-18T02:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture(turn?: FileTurn, onboarded = true) {
  const root = mkdtempSync(join(tmpdir(), "native-engine-"));
  roots.push(root);
  initializeWorkspace(root);
  const store = new Store(join(root, "workspace"));
  if (onboarded) store.updateSystem((state) => { state.onboardingCompletedAt = new Date().toISOString(); });
  const engine = new Engine(
    store,
    () => ({ kind: "codex", executable: "/controlled/no-real-cli" }),
    undefined,
    turn,
  );
  return { store, engine };
}
function create(engine: Engine, title = "测试事项") {
  engine.command({
    type: "create",
    requestId: randomUUID(),
    title,
    context: "原始背景",
  });
  if (engine.snapshot().onboardingCompletedAt) engine.command({ type: "research", kind: "daily", requestId: randomUUID() });
  return engine.snapshot().tasks.at(-1)!;
}
const reply = (files: FileMap, text = "已更新。") =>
  Object.assign(files, { reply: text });

it("keeps scheduled research and card execution idle until onboarding finishes, but permits background research and chat", async () => {
  const turn = vi.fn<FileTurn>(async (_config, files) => reply(files));
  const { engine, store } = fixture(turn, false);
  create(engine);
  store.updateSystem((state) => {
    state.queue.push({ kind: "user", id: randomUUID(), scope: "frontdesk", research: "daily", message: "先前已排队的巡检" });
    for (const kind of ["daily", "background"] as const) state.research[kind].nextAt = "2026-09-17T02:00:00.000Z";
  });
  engine.recover();
  await engine.tick();
  expect(turn).not.toHaveBeenCalled();
  expect(() => engine.command({ type: "research", kind: "daily", requestId: randomUUID() })).toThrow("请先完成背景调研");
  engine.command({ type: "research", kind: "background", requestId: randomUUID() });
  await engine.tick();
  expect(store.system().runs.at(-1)?.research).toBe("background");
  engine.command({ type: "chat", requestId: randomUUID(), message: "先补充近期工作的范围" });
  await engine.tick();
  await engine.tick();
  expect(turn).toHaveBeenCalledTimes(2);
  expect(store.system().queue).toHaveLength(1);
  expect(engine.snapshot().onboardingCompletedAt).toBeNull();
});

it("requires a published background before entering, persists the user's entry, and starts future schedules only then", async () => {
  const { engine, store } = fixture(async (_config, files) => {
    files.set("background/SUMMARY.md", "当前在准备演示，详细记录见调研资料。");
    return reply(files);
  }, false);
  const complete = { type: "onboarding_complete" as const, requestId: randomUUID() };
  expect(() => engine.command(complete)).toThrow("请先完成背景调研");
  engine.command({ type: "research", kind: "background", requestId: randomUUID() });
  expect(() => engine.command(complete)).toThrow("请等当前背景整理结束");
  await engine.tick();
  expect(engine.snapshot().onboardingCompletedAt).toBeNull();
  const messages = store.system().messages;
  engine.command(complete);
  const completed = store.system().onboardingCompletedAt;
  expect(completed).toBe(new Date().toISOString());
  expect(new Store(store.directory).system().onboardingCompletedAt).toBe(completed);
  expect(store.system().messages).toEqual(messages);
  expect(store.system().approvals).toEqual([]);
  expect(store.system().acceptances).toEqual([]);
  for (const kind of ["daily", "background"] as const) expect(Date.parse(store.system().research[kind].nextAt!)).toBeGreaterThan(Date.now());
  vi.setSystemTime(new Date("2026-09-18T03:00:00Z"));
  engine.command(complete);
  expect(store.system().onboardingCompletedAt).toBe(completed);
});

it("keeps incomplete onboarding recoverable after failure, empty results, and interruption during a correction", async () => {
  let attempt = 0;
  const { engine, store } = fixture(async (_config, files, _scope, _instruction, signal) => {
    attempt++;
    if (attempt === 1) throw new Error("调研断网");
    if (attempt === 3) {
      await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }
    return reply(files);
  }, false);
  for (let index = 0; index < 2; index++) {
    engine.command({ type: "research", kind: "background", requestId: randomUUID() });
    await engine.tick();
    expect(engine.snapshot().onboardingCompletedAt).toBeNull();
    expect(() => engine.command({ type: "onboarding_complete", requestId: randomUUID() })).toThrow("请先完成背景调研");
  }
  store.update((_state, files) => files.set("background/SUMMARY.md", "已有初步背景"));
  engine.command({ type: "chat", requestId: randomUUID(), message: "请纠正我的职责" });
  const running = engine.tick();
  expect(() => engine.command({ type: "onboarding_complete", requestId: randomUUID() })).toThrow("请等当前背景整理结束");
  engine.command({ type: "cancel" });
  await running;
  expect(new Store(store.directory).system().onboardingCompletedAt).toBeNull();
  expect(store.raw("background/SUMMARY.md")).toBe("已有初步背景");
});
it("pauses only failed background research while daily work keeps running", async () => {
  let fail = true;
  const turn = vi.fn<FileTurn>(async (_config, files) => {
    if (fail && JSON.parse(textContent(files.get("INTERACTIONS.md")!)).lane === "background") throw new FileTurnError("网络连接中断", "/controlled/recovery/run");
    return reply(files, "已继续调研");
  });
  const { engine, store } = fixture(turn);
  engine.recover();
  engine.command({ type: "research", kind: "background", requestId: randomUUID() });
  await engine.tick();
  expect(engine.snapshot().research.background.blockedReason).toContain("网络连接中断");
  expect(store.system().runs.at(-1)?.recoveryPath).toBe("/controlled/recovery/run");
  const notices = store.system().messages.length;
  vi.setSystemTime(new Date("2026-09-18T04:00:00Z"));
  engine.recover();
  await engine.tick(); await engine.tick();
  expect(turn).toHaveBeenCalledTimes(2);
  expect(store.system().messages).toHaveLength(notices + 1);
  expect(store.system().research.daily.lastCompletedAt).not.toBeNull();
  fail = false;
  engine.command({ type: "research", kind: "background", requestId: randomUUID() });
  await engine.tick();
  expect(turn).toHaveBeenCalledTimes(3);
  expect(engine.snapshot().research.background.blockedReason).toBeNull();
  expect(store.system().research.background.lastCompletedAt).toBe("2026-09-18T04:00:00.000Z");
});
it("shows live progress and stops only the current run on user cancellation", async () => {
  const { engine, store } = fixture(async (_config, _files, _scope, _instruction, signal, runtime) => {
    runtime?.onProgress("正在准备本轮资料");
    runtime?.onProgress("AI 已启动，等待进展");
    runtime?.onProgress("正在查看网页");
    await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), {once:true}));
    throw new Error("unreachable");
  });
  engine.command({ type: "research", kind: "daily", requestId: randomUUID() });
  const running = engine.tick();
  expect(engine.snapshot().runs.at(-1)?.progress).toBe("正在查看网页");
  engine.command({ type: "cancel" });
  await running;
  expect(engine.snapshot().busy).toBe(false);
  expect(engine.snapshot().paused).toBe(false);
  expect(store.system().runs.at(-1)?.status).toBe("interrupted");
  expect(store.system().runs.at(-1)?.detail).toContain("你已停止");
});
it("lets the single assistant interpret a natural reference, edit any card, and create free project notes", async () => {
  const { store, engine } = fixture(
    async (_config, files, writable, instruction) => {
      expect(writable).toEqual(["assistant/", "tasks/"]);
      expect(instruction).toContain("那个发布准备");
      files.set(
        cardFile("PIL-1"),
        encodeCard(
          { title: "发布准备", status: "paused", request: null },
          "摘要 [细节](research/notes.md)",
        ),
      );
      files.set("tasks/PIL-1/research/notes.md", "详细沉淀");
      files.set("assistant/关注.md", "自由组织");
      return reply(files);
    },
  );
  create(engine);
  store.updateSystem((state) => { state.queue = []; });
  engine.command({
    type: "chat",
    requestId: randomUUID(),
    message: "那个发布准备先暂停，保留研究",
  });
  await engine.tick();
  expect(engine.snapshot().tasks[0]?.status).toBe("paused");
  expect(store.raw("tasks/PIL-1/research/notes.md")).toBe("详细沉淀");
  expect(store.system().messages.at(-1)?.role).toBe("assistant");
});

it("runs a persisted 30-minute scan once after restart and stays quiet without meaningful changes", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-18T00:00:00Z"));
  const turn = vi.fn<FileTurn>(
    async (_config, files, _writable, instruction) => {
      expect(instruction).toContain("查看当天全貌");
      expect(instruction).toContain("Trigger: automatic");
      return reply(files, "NO_UPDATE");
    },
  );
  const { store, engine } = fixture(turn);
  engine.recover();
  await engine.tick();
  expect(turn).not.toHaveBeenCalled();
  vi.setSystemTime(new Date("2026-09-18T00:29:59Z"));
  await engine.tick();
  expect(turn).not.toHaveBeenCalled();
  vi.setSystemTime(new Date("2026-09-18T02:00:00Z"));
  const restored = new Engine(
    store,
    () => ({ kind: "codex", executable: "/fake" }),
    undefined,
    turn,
  );
  restored.recover();
  await restored.tick();
  await restored.tick();
  expect(turn).toHaveBeenCalledTimes(1);
  expect(store.system().messages).toHaveLength(0);
  expect(store.system().research.daily.lastCompletedAt).toBe(
    "2026-09-18T02:00:00.000Z",
  );
  expect(store.system().research.daily.nextAt).toBe("2026-09-18T02:30:00.000Z");
});

it.each([
  "2026-09-18T09:59:59+08:00",
  "2026-09-18T22:00:00+08:00",
  "2026-09-19T12:00:00+08:00",
  "2026-09-25T12:00:00+08:00",
  "2027-01-01T12:00:00+08:00",
])("does not wake the AI for due automatic research outside the work window: %s", async (at) => {
  vi.setSystemTime(new Date(at));
  const turn = vi.fn<FileTurn>(async (_config, files) => reply(files));
  const { store, engine } = fixture(turn);
  engine.recover();
  store.updateSystem((state) => {
    state.research.daily.nextAt = "2026-09-17T00:00:00.000Z";
    state.research.background.nextAt = "2026-09-17T00:00:00.000Z";
  });
  await engine.tick();
  await engine.tick();
  expect(turn).not.toHaveBeenCalled();
  expect(store.system().runs).toHaveLength(0);
  engine.command({ type: "chat", requestId: randomUUID(), message: "我主动问一下" });
  await engine.tick();
  engine.command({ type: "research", requestId: randomUUID(), kind: "background" });
  await engine.tick();
  expect(turn).toHaveBeenCalledTimes(2);
  expect(store.system().runs.every((run) => run.source === "user")).toBe(true);
});

it("resumes a missed scan once on a make-up Sunday at 10 and defers the next night scan", async () => {
  const turn = vi.fn<FileTurn>(async (_config, files) => reply(files, "NO_UPDATE"));
  const { store, engine } = fixture(turn);
  vi.setSystemTime(new Date("2026-09-18T21:45:00+08:00"));
  engine.recover();
  expect(store.system().research.daily.nextAt).toBe("2026-09-20T02:00:00.000Z");
  vi.setSystemTime(new Date("2026-09-20T09:59:59+08:00"));
  await engine.tick();
  expect(turn).not.toHaveBeenCalled();
  vi.setSystemTime(new Date("2026-09-20T10:00:00+08:00"));
  await engine.tick();
  await engine.tick();
  expect(turn).toHaveBeenCalledTimes(2);
  expect(store.system().runs[0]?.research).toBe("background");
  expect(store.system().research.daily.nextAt).toBe("2026-09-20T02:30:00.000Z");
});

it("persists model classification through file publication, pause and snapshot without inferring from prose", async () => {
  const { store, engine } = fixture(async (_config, files) => {
    files.set(cardFile("PIL-2"), encodeCard({
      title: "提前准备验证材料", category: "proactive", status: "todo", request: null,
    }, "与当前目标有关，先准备本地材料。"));
    return reply(files);
  });
  expect(create(engine).category).toBe("commitment");
  await engine.tick();
  const proactive = engine.snapshot().tasks.find((task) => task.id === "PIL-2")!;
  expect(proactive.category).toBe("proactive");
  engine.command({ type: "task", action: "pause", requestId: randomUUID(), taskId: proactive.id, digest: proactive.digest });
  expect(parseCard(store.raw(cardFile(proactive.id))).header.category).toBe("proactive");
});

it("runs due background and daily research separately and records independent completion", async () => {
  const turn = vi.fn<FileTurn>(async (_config, files) => {
    const lane = JSON.parse(textContent(files.get("INTERACTIONS.md")!)).lane;
    if (lane === "background") files.set("background/SUMMARY.md", "调研后的近期背景");
    else files.set("assistant/ATTENTION.md", "工作结果");
    return reply(files);
  });
  const { store, engine } = fixture(turn);
  engine.recover();
  store.updateSystem((state) => {
    state.research.background.nextAt = state.research.daily.nextAt = new Date().toISOString();
  });
  await engine.tick();
  await engine.tick();
  expect(turn).toHaveBeenCalledTimes(2);
  expect(store.system().runs.map((run) => [run.research, run.status])).toEqual([["background", "succeeded"], ["daily", "succeeded"]]);
  expect(engine.snapshot().background.body).toBe("调研后的近期背景");
  expect(engine.snapshot().attention).toBe("工作结果");
  expect(store.system().messages.map((message) => message.scope)).toEqual(["background", "frontdesk"]);
});

it("queues independent background research while work runs without cancelling it or duplicating requests", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let count = 0;
  const { store, engine } = fixture(
    async (_config, files, _writable, instruction, signal) => {
      if (++count === 1) {
        await gate;
        expect(signal.aborted).toBe(false);
      } else {
        expect(instruction).toContain("Trigger: manual");
        files.set("background/SUMMARY.md", "手动全面刷新结果");
      }
      return reply(files, "已完成当前请求。");
    },
  );
  engine.command({
    type: "chat",
    requestId: randomUUID(),
    message: "整理当前事项",
  });
  const active = engine.tick();
  engine.command({
    type: "research",
    requestId: randomUUID(),
    kind: "background",
  });
  engine.command({
    type: "research",
    requestId: randomUUID(),
    kind: "background",
  });
  expect(engine.snapshot().research.queued).toEqual(["background"]);
  release();
  await active;
  await engine.tick();
  expect(count).toBe(2);
  expect(store.system().runs.every((run) => run.status === "succeeded")).toBe(
    true,
  );
  expect(engine.snapshot().background.body).toBe("手动全面刷新结果");
});

it("honors schedule switches and global pause while keeping manual refresh available", async () => {
  const turn = vi.fn<FileTurn>(async (_config, files) =>
    reply(files, "刷新完成"),
  );
  const { store, engine } = fixture(turn);
  engine.recover();
  store.updateSystem((state) => {
    state.research.daily.nextAt = "2020-01-01T00:00:00.000Z";
  });
  engine.command({
    type: "research_schedule",
    kind: "daily",
    enabled: false,
    requestId: randomUUID(),
  });
  await engine.tick();
  expect(turn).not.toHaveBeenCalled();
  store.updateSystem((state) => {
    state.research.background.nextAt = "2020-01-01T00:00:00.000Z";
  });
  engine.command({ type: "pause", paused: true });
  await engine.tick();
  expect(turn).not.toHaveBeenCalled();
  engine.command({
    type: "research",
    kind: "background",
    requestId: randomUUID(),
  });
  await engine.tick();
  expect(turn).toHaveBeenCalledTimes(1);
  expect(store.system().research.daily.enabled).toBe(false);
});

it("does not report failed research as completed or retry it on every 5-second tick", async () => {
  const turn = vi.fn<FileTurn>(async () => {
    throw new Error("来源访问失败");
  });
  const { store, engine } = fixture(turn);
  engine.recover();
  store.updateSystem((state) => {
    state.research.daily.nextAt = "2020-01-01T00:00:00.000Z";
  });
  await engine.tick();
  await engine.tick();
  expect(turn).toHaveBeenCalledTimes(1);
  expect(store.system().research.daily.lastCompletedAt).toBeNull();
  expect(store.system().runs.at(-1)?.status).toBe("failed");
});

it("reserves the automatic budget without blocking an explicit manual refresh", async () => {
  const turn = vi.fn<FileTurn>(async (_config, files) =>
    reply(files, "手动刷新完成"),
  );
  const { store, engine } = fixture(turn);
  engine.recover();
  store.updateSystem((state) => {
    state.research.daily.nextAt = "2020-01-01T00:00:00.000Z";
    state.runs = Array.from({ length: 96 }, () => ({
      id: randomUUID(),
      scope: "frontdesk",
      source: "automatic",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      status: "succeeded",
      detail: "已检查",
    }));
  });
  await engine.tick();
  expect(turn).not.toHaveBeenCalled();
  engine.command({
    type: "research",
    kind: "background",
    requestId: randomUUID(),
  });
  await engine.tick();
  expect(turn).toHaveBeenCalledTimes(1);
  expect(store.system().runs.at(-1)?.source).toBe("user");
});
it("keeps all cards in the work context while retaining background as a read-only reference", async () => {
  const { store, engine } = fixture(
    async (_config, files, writable, instruction) => {
      expect(writable).toEqual(["assistant/", "tasks/"]);
      expect(files.has(cardFile("PIL-2"))).toBe(true);
      expect(instruction).not.toContain("Mode: PROJECT");
      const interactions = JSON.parse(textContent(files.get("INTERACTIONS.md")!));
      expect(
        interactions.messages.some(
          (item: { body: string }) =>
            item.body === "原始要求和授权保留在全局对话",
        ),
      ).toBe(true);
      files.set("assistant/背景线索.md", "推进中学到的新背景");
      files.set("assistant/ATTENTION.md", "结果已准备好");
      files.set("tasks/PIL-1/result.md", "完整结果");
      files.set(
        cardFile("PIL-1"),
        encodeCard(
          { title: "测试事项", status: "done", request: null },
          "已完成，见 [成果](result.md)。",
        ),
      );
      return reply(files);
    },
  );
  create(engine);
  create(engine, "另一个事项");
  store.updateSystem((state) => {
    state.messages.push({
      id: randomUUID(),
      scope: "frontdesk",
      role: "user",
      body: "原始要求和授权保留在全局对话",
      at: new Date().toISOString(),
    });
  });
  await engine.tick();
  expect(engine.snapshot().tasks[0]?.status).toBe("done");
  expect(store.system().approvals).toEqual([]);
  expect(store.system().queue).toEqual([]);
  expect(store.system().messages.find((item) => item.scope === "PIL-2")?.review?.status).toBe("pending");
  expect(store.system().messages.at(-1)).toMatchObject({
    scope: "frontdesk",
    contextId: "PIL-1",
    role: "assistant",
  });
  expect(engine.snapshot().background.body).toBe("");
  expect(store.raw("assistant/背景线索.md")).toBe("推进中学到的新背景");
  expect(engine.snapshot().attention).toBe("结果已准备好");
});
it.each(["manual", "automatic"])("batches saved reviews on %s advancement and preserves next-batch feedback during publication", async (trigger) => {
  const gate = Promise.withResolvers<void>();
  const inputs: { submittedReviews: { body: string }[]; messages: { body: string }[]; priorityTaskIds: string[] }[] = [];
  const signals: AbortSignal[] = [];
  const turn = vi.fn<FileTurn>(async (_config, files, writable, instruction, signal) => {
    const input = JSON.parse(textContent(files.get("INTERACTIONS.md")!));
    inputs.push(input); signals.push(signal);
    expect(writable).toEqual(["assistant/", "tasks/"]);
    expect(instruction).toContain("marker-work-plan");
    expect(instruction).toContain("marker-daily-plan");
    expect(instruction).toContain("first priority, not the boundary of this run");
    expect(instruction).toContain("latest background");
    if (inputs.length === 1) await gate.promise;
    expect(signal.aborted).toBe(false);
    files.set(cardFile("PIL-1"), encodeCard({ title: "重点事项", status: "waiting", request: null }, "已处理本批反馈，等待结果。"));
    files.set(cardFile("PIL-2"), encodeCard({ title: "另一项工作", status: "done", request: null }, "成果等待验收。"));
    files.set("assistant/ATTENTION.md", "全局本轮变化");
    return reply(files, "两项工作的结果与下一步。");
  });
  const { store, engine } = fixture(turn);
  store.update((state, files) => {
    for (const id of ["PIL-1", "PIL-2"]) files.set(cardFile(id), encodeCard({ title: id, status: "waiting", request: null }, "现状"));
    files.set("background/SUMMARY.md", "最新背景");
    state.research.background.enabled = false;
    state.research.daily.nextAt = "2026-09-18T02:30:00.000Z";
  });
  const before = store.files();
  const plans = join(dirname(store.directory), ".agents/skills/taskpilot-files/prompts");
  writeFileSync(join(plans, "work.md"), "marker-work-plan");
  writeFileSync(join(plans, "daily.md"), "marker-daily-plan");
  const first = { type: "note" as const, taskId: "PIL-1", message: "第一条意见", requestId: randomUUID() };
  engine.command(first); engine.command(first);
  engine.command({ type: "note", taskId: "PIL-2", message: "第二条意见", requestId: randomUUID() });
  await engine.tick();
  expect(turn).not.toHaveBeenCalled();
  expect(store.files()).toEqual(before);
  expect(new Store(store.directory).system().messages.filter((item) => item.review?.status === "pending")).toHaveLength(2);
  expect(store.system().queue).toEqual([]);
  expect(engine.snapshot().tasks.every((task) => task.status === "awaiting_ai")).toBe(true);
  if (trigger === "manual") {
    engine.command({ type: "research", kind: "daily", requestId: randomUUID() });
    engine.command({ type: "research", kind: "daily", requestId: randomUUID() });
    expect(store.system().queue).toHaveLength(1);
    expect(store.system().queue[0]?.taskIds).toEqual(["PIL-1", "PIL-2"]);
    expect(engine.snapshot().tasks.every((task) => task.status === "queued")).toBe(true);
  } else {
    vi.setSystemTime(new Date("2026-09-18T02:30:00Z"));
  }
  const running = engine.tick();
  expect(engine.snapshot().tasks.every((task) => task.status === "running")).toBe(true);
  expect(store.system().runs.at(-1)?.source).toBe(trigger === "manual" ? "user" : "automatic");
  engine.command({ type: "note", taskId: "PIL-1", message: "下一批意见", requestId: randomUUID() });
  engine.command({ type: "research", kind: "daily", requestId: randomUUID() });
  expect(signals[0]?.aborted).toBe(false);
  expect(inputs[0]?.submittedReviews.map((item) => item.body)).toEqual(["第一条意见", "第二条意见"]);
  expect(inputs[0]?.messages.some((item) => item.body === "下一批意见")).toBe(false);
  expect(store.system().queue).toEqual([]);
  vi.setSystemTime(new Date("2026-09-18T02:45:00Z"));
  gate.resolve(); await running; await engine.tick();
  expect(turn).toHaveBeenCalledTimes(1);
  expect(store.system().runs.at(-1)?.status).toBe("succeeded");
  expect(store.system().messages.filter((item) => item.review?.status === "pending")).toHaveLength(1);
  expect(store.system().messages.at(-1)?.contextIds).toEqual(["PIL-1", "PIL-2"]);
  expect(store.system().research.daily).toMatchObject({ lastCompletedAt: "2026-09-18T02:45:00.000Z", nextAt: "2026-09-18T03:15:00.000Z" });
  expect(engine.snapshot().tasks.find((task) => task.id === "PIL-2")?.status).toBe("done");
  expect(engine.snapshot().attention).toBe("全局本轮变化");
  expect(store.system().approvals).toEqual([]);
  expect(store.system().acceptances).toEqual([]);
  expect(engine.snapshot().tasks.find((task) => task.id === "PIL-1")?.status).toBe("awaiting_ai");
  if (trigger === "manual") engine.command({ type: "research", kind: "daily", requestId: randomUUID() });
  else vi.setSystemTime(new Date("2026-09-18T03:15:00Z"));
  await engine.tick();
  expect(turn).toHaveBeenCalledTimes(2);
  expect(inputs[1]?.submittedReviews.map((item) => item.body)).toEqual(["下一批意见"]);
  expect(inputs[1]?.priorityTaskIds).toEqual(["PIL-1"]);
});

it("persists unsent card reviews across restart and returns the submitted batch reply to its activity", async () => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  const turn = vi.fn<FileTurn>(async (_config, files, writable, _instruction) => {
    const input = JSON.parse(textContent(files.get("INTERACTIONS.md")!));
    expect(writable).toEqual(["assistant/", "tasks/"]);
    expect(input.priorityTaskIds).toEqual(["PIL-1"]);
    expect(input.submittedReviews.at(-1)).toMatchObject({ scope: "PIL-1", role: "user", body: "先核实回执，不要重复发送" });
    expect(input.approvals).toEqual([]);
    expect(textContent(files.get("background/SUMMARY.md")!)).toBe("本轮最新背景");
    await ready;
    files.set(cardFile("PIL-1"), encodeCard({ title: "核实账单回执", status: "waiting", request: null }, "已按批注核实，等待对方确认。"));
    return reply(files, "已核实回执，未重复发送。下一步等待确认。");
  });
  const { store, engine } = fixture(turn);
  store.update((state, files) => {
    files.set(cardFile("PIL-1"), encodeCard({ title: "核实账单回执", status: "paused", request: null }, "已有上下文"));
    files.set(cardFile("PIL-2"), encodeCard({ title: "其他事项", status: "paused", request: null }, "不受此次批注影响"));
    files.set("background/SUMMARY.md", "本轮最新背景");
    state.paused = true;
    state.research.daily.enabled = false;
    state.research.background.enabled = false;
  });
  const command = { type: "note" as const, taskId: "PIL-1", requestId: randomUUID(), message: "先核实回执，不要重复发送" };
  engine.command(command);
  engine.command(command);
  expect(engine.snapshot().tasks.find((task) => task.id === "PIL-1")).toMatchObject({ queued: false, status: "awaiting_ai" });
  const persisted = new Store(store.directory).system();
  expect(persisted.messages).toHaveLength(1);
  expect(persisted.queue).toEqual([]);
  expect(persisted.messages[0]?.review?.status).toBe("pending");
  expect(persisted.approvals).toEqual([]);
  expect(persisted.acceptances).toEqual([]);
  engine.command({ type: "research", kind: "daily", requestId: randomUUID() });
  const running = engine.tick();
  expect(engine.snapshot().tasks.find((task) => task.id === "PIL-1")).toMatchObject({ queued: false, status: "running" });
  release();
  await running;
  await engine.tick();
  expect(turn).toHaveBeenCalledTimes(1);
  expect(store.system().runs.at(-1)?.status).toBe("succeeded");
  expect(engine.snapshot().tasks.find((task) => task.id === "PIL-1")).toMatchObject({ queued: false, status: "waiting" });
  expect(engine.snapshot().tasks.find((task) => task.id === "PIL-2")).toMatchObject({ queued: false, status: "paused" });
  expect(store.system().messages.at(-1)).toMatchObject({ role: "assistant", contextId: "PIL-1", body: "已核实回执，未重复发送。下一步等待确认。" });
});

it("binds user approval to all project files, rejects stale approval and never equates a note with consent", async () => {
  const { store, engine } = fixture();
  create(engine);
  store.update((state, files) => {
    state.queue = [];
    files.set(
      cardFile("PIL-1"),
      encodeCard(
        {
          title: "审批",
          status: "review",
          request: { kind: "approval", question: "批准这份草稿？" },
        },
        "具体草稿",
      ),
    );
  });
  const stale = engine.snapshot().tasks[0]!;
  store.update((_state, files) => {
    files.set("tasks/PIL-1/draft.md", "补充附件");
  });
  expect(() =>
    engine.command({
      type: "approve",
      requestId: randomUUID(),
      taskId: "PIL-1",
      digest: stale.digest,
    }),
  ).toThrow("已有更新");
  const current = engine.snapshot().tasks[0]!;
  const requestId = randomUUID();
  engine.command({
    type: "approve",
    requestId,
    taskId: "PIL-1",
    digest: current.digest,
  });
  engine.command({
    type: "approve",
    requestId,
    taskId: "PIL-1",
    digest: current.digest,
  });
  expect(store.system().approvals).toHaveLength(0);
  expect(store.system().messages.filter((item) => item.review?.status === "pending")).toHaveLength(1);
  engine.command({
    type: "note",
    requestId: randomUUID(),
    taskId: "PIL-1",
    message: "再给一个选项",
  });
  expect(store.system().approvals).toHaveLength(0);
  engine.command({ type: "research", kind: "daily", requestId: randomUUID() });
  expect(store.system().approvals).toHaveLength(1);
  expect(store.system().approvals[0]?.document).toContain("具体草稿");
});
it("keeps host-owned records outside model publication and rejects the whole invalid edit", async () => {
  const { store, engine } = fixture(async (_config, files) => {
    files.set("SYSTEM.json", "伪造审批");
    files.set(
      cardFile("PIL-1"),
      encodeCard({ title: "越界", status: "done", request: null }, ""),
    );
    return reply(files, "伪成功");
  });
  const before = create(engine);
  await engine.tick();
  expect(store.system().approvals).toEqual([]);
  expect(engine.snapshot().tasks[0]?.title).toBe(before.title);
  expect(store.system().runs.at(-1)?.detail).toContain("超出本轮");
  expect(store.system().runs.at(-1)?.status).toBe("failed");
});
it("requires user acceptance of the current delivery before archiving and preserves the receipt", async () => {
  const { store, engine } = fixture();
  const initial = create(engine);
  const archive = (digest: string, requestId = randomUUID()) => engine.command({
    type: "task", action: "archive", taskId: initial.id, digest, requestId,
  });
  expect(() => archive(initial.digest)).toThrow("尚未提交验收");
  store.update((_state, files) => {
    files.set(cardFile(initial.id), encodeCard(
      { title: "交付", status: "done", request: null },
      "交付结果，见 [成果](result.md)",
    ));
    files.set(`tasks/${initial.id}/result.md`, "第一版成果");
  });
  const stale = engine.snapshot().tasks[0]!;
  store.update((_state, files) => {
    files.set(`tasks/${initial.id}/result.md`, "第二版成果");
  });
  expect(() => archive(stale.digest)).toThrow("已有更新");
  expect(store.system().acceptances).toEqual([]);
  const current = engine.snapshot().tasks[0]!;
  const requestId = randomUUID();
  archive(current.digest, requestId);
  archive(current.digest, requestId);
  expect(engine.snapshot().tasks[0]?.status).toBe("archived");
  expect(store.system().queue.some((item) => item.taskIds?.includes(initial.id))).toBe(false);
  expect(store.system().acceptances).toHaveLength(1);
  expect(store.system().acceptances[0]).toMatchObject({
    id: requestId, taskId: initial.id, digest: current.digest,
  });
  expect(store.system().acceptances[0]?.document).toContain("交付结果");
  expect(store.system().approvals).toEqual([]);
  expect(store.system().messages.at(-1)?.body).toContain("用户验收通过");
  expect(new Store(store.directory).system().acceptances).toEqual(store.system().acceptances);
  engine.command({
    type: "task", action: "resume", taskId: initial.id,
    digest: engine.snapshot().tasks[0]!.digest, requestId: randomUUID(),
  });
  expect(engine.snapshot().tasks[0]?.status).toBe("awaiting_ai");
  expect(parseCard(store.raw(cardFile(initial.id))!).header.status).toBe("archived");
  expect(store.system().messages.at(-1)?.review).toMatchObject({ status: "pending", action: "resume" });
  expect(() => archive(engine.snapshot().tasks[0]!.digest)).toThrow("尚未提交验收");
  expect(store.system().acceptances).toHaveLength(1);
});
it("supports free background notes and deletion without requiring a knowledge taxonomy", async () => {
  const { store, engine } = fixture(async (_config, files) => {
    files.set("background/SUMMARY.md", "简短总结");
    files.set("background/notes/context.md", "详细近况");
    files.delete("background/旧.md");
    return reply(files);
  });
  store.update((_state, files) => files.set("background/旧.md", "过时信息"));
  engine.command({
    type: "chat",
    requestId: randomUUID(),
    message: "更新近况",
    lane: "background",
  });
  await engine.tick();
  expect(engine.snapshot().background.body).toBe("简短总结");
  expect(store.files().has("background/旧.md")).toBe(false);
  expect(store.raw("background/notes/context.md")).toBe("详细近况");
});
it("persists offline inputs idempotently and runs them once after a model becomes available", async () => {
  const { store } = fixture();
  let connected = false;
  const turn = vi.fn<FileTurn>(async (_config, files) => reply(files));
  const engine = new Engine(
    store,
    () => (connected ? { kind: "codex", executable: "/fake" } : null),
    undefined,
    turn,
  );
  const command = {
    type: "chat" as const,
    requestId: randomUUID(),
    message: "自然语言请求",
  };
  engine.command(command);
  engine.command(command);
  await engine.tick();
  expect(store.system().queue).toHaveLength(1);
  expect(turn).not.toHaveBeenCalled();
  connected = true;
  await engine.tick();
  await engine.tick();
  expect(turn).toHaveBeenCalledTimes(1);
});
it("aborts stale results when the user pauses and preserves the original files", async () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { store, engine } = fixture(async (_config, files) => {
    await wait;
    files.set(
      cardFile("PIL-1"),
      encodeCard({ title: "stale", status: "done", request: null }, "stale"),
    );
    return reply(files);
  });
  create(engine);
  const running = engine.tick();
  expect(engine.snapshot().busy).toBe(true);
  engine.command({ type: "pause", paused: true });
  release();
  await running;
  expect(parseCard(store.raw(cardFile("PIL-1"))).header.title).toBe("测试事项");
  expect(store.system().runs[0]?.status).toBe("interrupted");
  expect(engine.snapshot().paused).toBe(true);
});
it("does not loop over unchanged todo cards and recovers interrupted runs without silent replay", async () => {
  const turn = vi.fn<FileTurn>(async (_config, files) => reply(files));
  const { store, engine } = fixture(turn);
  create(engine);
  await engine.tick();
  await engine.tick();
  expect(turn).toHaveBeenCalledTimes(1);
  expect(engine.snapshot().tasks[0]?.error).toBeNull();
  store.update((state) => {
    delete state.errors["PIL-1"];
    state.runs.push({
      id: randomUUID(),
      scope: "PIL-1",
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      detail: "",
    });
  });
  const restored = new Engine(store);
  restored.recover();
  expect(restored.snapshot().tasks[0]?.status).toBe("blocked");
  expect(store.system().runs.at(-1)?.status).toBe("interrupted");
});
it("rejects concurrent external edits instead of replacing newer project work", async () => {
  const { store, engine } = fixture(async (_config, files) => {
    writeFileSync(
      join(store.directory, cardFile("PIL-1")),
      encodeCard(
        { title: "新内容", status: "paused", request: null },
        "手工修改",
      ),
    );
    files.set(
      cardFile("PIL-1"),
      encodeCard({ title: "过时", status: "done", request: null }, ""),
    );
    return reply(files);
  });
  create(engine);
  await engine.tick();
  expect(parseCard(store.raw(cardFile("PIL-1"))).header.title).toBe("新内容");
  expect(store.system().runs.at(-1)?.detail).toContain("较新修改");
});

it("lets a global conversation repair and resume a blocked project without a second chat", async () => {
  const { store, engine } = fixture(async (_config, files) => {
    files.set(
      cardFile("PIL-1"),
      encodeCard(
        { title: "已调整", status: "todo", request: null },
        "根据新反馈重新准备",
      ),
    );
    return reply(files);
  });
  create(engine);
  store.updateSystem((state) => {
    state.errors["PIL-1"] = "旧运行失败";
  });
  engine.command({
    type: "chat",
    requestId: randomUUID(),
    contextId: "PIL-1",
    message: "调整后继续",
  });
  await engine.tick();
  expect(engine.snapshot().tasks[0]?.status).toBe("todo");
  expect(
    store.system().messages.find((item) => item.body === "调整后继续")
      ?.contextId,
  ).toBe("PIL-1");
});
it("does not silently rerun a project interrupted by a clean shutdown", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { store, engine } = fixture(async (_config, files) => {
    await gate;
    return reply(files);
  });
  create(engine);
  const running = engine.tick();
  engine.stop();
  release();
  await running;
  const restored = new Engine(store);
  restored.recover();
  expect(restored.snapshot().tasks[0]?.status).toBe("blocked");
});

it("persists custom research timing and does not interrupt an active turn to change the schedule", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-18T09:00:00+08:00"));
  const {engine,store} = fixture();
  engine.command({type:"research_settings",requestId:randomUUID(),settings:{days:"weekdays",start:"09:30",end:"18:15",dailyMinutes:45,backgroundMinutes:1440}});
  expect(engine.snapshot().research.settings.start).toBe("09:30");
  expect(store.system().research.daily.nextAt).toBe("2026-09-18T01:45:00.000Z");
  expect(store.system().research.background.nextAt).toBe("2026-09-21T01:30:00.000Z");
  expect(store.system().messages).toEqual([]);
});

it("wakes immediately for an explicit task action even while automatic work is paused", async () => {
  const turn = vi.fn<FileTurn>(async (_config,files) => {
    const card = parseCard(files.get(cardFile("PIL-1"))!);
    files.set(cardFile("PIL-1"),encodeCard({...card.header,status:"done"},"完成并待验收"));
    return reply(files);
  });
  const {engine,store} = fixture(turn);
  store.updateSystem((state) => { state.paused = true; });
  create(engine);
  engine.wake();
  await vi.waitFor(() => expect(store.system().runs.at(-1)?.status).toBe("succeeded"));
  expect(turn).toHaveBeenCalledTimes(1);
  expect(store.system().runs.at(-1)?.source).toBe("user");
  expect(store.system().paused).toBe(true);
});

it("consumes a new user message immediately after the interrupted turn has settled", async () => {
  let calls=0;
  const {engine,store} = fixture(async (_config,files,_writable,_instruction,signal) => {
    if (++calls === 1) await new Promise((_resolve,reject) => signal.addEventListener("abort",()=>reject(signal.reason),{once:true}));
    return reply(files);
  });
  engine.command({type:"chat",requestId:randomUUID(),message:"第一轮"});
  engine.wake();
  await vi.waitFor(() => expect(engine.snapshot().busy).toBe(true));
  engine.command({type:"chat",requestId:randomUUID(),message:"新的修改意见"});
  engine.wake();
  await vi.waitFor(() => expect(store.system().runs.at(-1)?.status).toBe("succeeded"));
  expect(calls).toBe(2);
  expect(store.system().queue).toEqual([]);
  expect(store.system().runs.map((run)=>run.status)).toEqual(["interrupted","succeeded"]);
});

it("keeps invalid model output as an unpublished recovery draft", async () => {
  const { store, engine } = fixture(async (_config, files) => {
    files.set("background/SUMMARY.md", Buffer.from([0xff, 0x80]));
    files.set("background/evidence.bin", Buffer.from([0, 0xff, 0x81]));
    return reply(files, "已整理");
  });
  engine.command({ type: "research", kind: "background", requestId: randomUUID() });
  await engine.tick();
  const run = store.system().runs.at(-1)!;
  expect(run.status).toBe("failed");
  expect(run.detail).toContain("UTF-8");
  expect(run.recoveryPath).toBeTruthy();
  expect(readFileSync(join(run.recoveryPath!, "workspace/background/evidence.bin"))).toEqual(Buffer.from([0, 0xff, 0x81]));
  expect(store.raw("background/SUMMARY.md")).toBe("");
});

it("rereads the model-maintained work and research plans each turn without reinitialization", async () => {
  const instructions: string[] = [];
  const { store, engine } = fixture(async (_config, files, _scope, instruction) => {
    instructions.push(instruction);
    return reply(files, "已按计划处理");
  });
  const plans = join(dirname(store.directory), ".agents/skills/taskpilot-files/prompts");
  writeFileSync(join(plans, "work.md"), "本轮先核对交付结果 marker-first");
  engine.command({ type: "chat", message: "接着做", requestId: randomUUID() });
  await engine.tick();
  expect(instructions[0]).toContain("marker-first");
  writeFileSync(join(plans, "work.md"), "已核对，下一步准备验收 marker-next");
  writeFileSync(join(plans, "daily.md"), "今天沿已确认项目追溯 marker-research");
  initializeWorkspace(dirname(store.directory));
  engine.command({ type: "research", kind: "daily", requestId: randomUUID() });
  await engine.tick();
  expect(instructions[1]).toContain("marker-next");
  expect(instructions[1]).toContain("marker-research");
  expect(instructions[1]).not.toContain("marker-first");
  expect(store.system().runs).toHaveLength(2);
});

it("a manual daily refresh can research and advance authorized work in the same turn", async () => {
  const { store, engine } = fixture(async (_config, files) => {
    files.set("assistant/ATTENTION.md", "已核对今天的新变化");
    files.set(cardFile("PIL-1"), encodeCard({ title: "整理材料", status: "done", request: null }, "整理完成，等待验收"));
    files.set("tasks/PIL-1/result.md", "实际准备的成果");
    return reply(files, "已调研并完成准备，请验收。");
  });
  create(engine, "整理材料");
  // The queued card represents work already authorized by a prior user request.
  store.updateSystem((state) => { state.queue = []; state.paused = true; });
  engine.command({ type: "research", kind: "daily", requestId: randomUUID() });
  engine.command({ type: "research", kind: "daily", requestId: randomUUID() });
  expect(store.system().queue).toHaveLength(1);
  await engine.tick();
  expect(store.system().runs).toHaveLength(1);
  expect(store.system().runs[0]).toMatchObject({ source: "user", research: "daily", status: "succeeded" });
  expect(engine.snapshot().tasks[0]?.status).toBe("done");
  expect(engine.snapshot().attention).toBe("已核对今天的新变化");
  expect(store.system().acceptances).toEqual([]);
});

it.each(["background", "work"] as const)("publishes concurrent lanes in %s-first order without losing either result, then reads fresh background", async (first) => {
  const gates = { background: Promise.withResolvers<void>(), work: Promise.withResolvers<void>() };
  const contexts: Record<"work" | "background", { body: string; prompt: string; messages: { body: string }[] }[]> = { background: [], work: [] };
  const { engine, store } = fixture(async (_config, files, _writable, prompt) => {
    const interactions = JSON.parse(textContent(files.get("INTERACTIONS.md")!));
    const lane = interactions.lane as "work" | "background";
    contexts[lane]!.push({ body: textContent(files.get("background/SUMMARY.md")!), prompt, messages: interactions.messages });
    await gates[lane].promise;
    files.set(lane === "background" ? "background/SUMMARY.md" : "assistant/ATTENTION.md", lane === "background" ? "最新背景" : "工作结果");
    return reply(files, lane === "background" ? "背景完成" : "工作完成");
  });
  store.update((_state, files) => files.set("background/SUMMARY.md", "旧背景"));
  engine.command({ type: "chat", lane: "background", message: "背景独立消息", requestId: randomUUID() });
  engine.command({ type: "chat", lane: "work", message: "工作独立消息", requestId: randomUUID() });
  const running = engine.tick();
  expect(engine.snapshot().activeScopes.sort()).toEqual(["background", "frontdesk"]);
  expect(store.system().runs.filter((run) => run.status === "running")).toHaveLength(2);
  expect(contexts.work[0]!.body).toBe("旧背景");
  expect(contexts.work[0]!.messages.map((message) => message.body)).toEqual(["工作独立消息"]);
  expect(contexts.background[0]!.messages.map((message) => message.body)).toEqual(["背景独立消息"]);
  expect(contexts.work[0]!.prompt).toContain("Before planning or acting, read background/SUMMARY.md");
  expect(contexts.background[0]!.prompt).not.toContain("prompts/work.md");
  gates[first].resolve();
  await vi.waitFor(() => expect(store.system().runs.filter((run) => run.status === "succeeded")).toHaveLength(1));
  expect(engine.snapshot().busy).toBe(true);
  gates[first === "background" ? "work" : "background"].resolve();
  await running;
  expect(engine.snapshot().busy).toBe(false);
  expect(store.system().runs.every((run) => run.status === "succeeded")).toBe(true);
  expect(store.raw("background/SUMMARY.md")).toBe("最新背景");
  expect(store.raw("assistant/ATTENTION.md")).toBe("工作结果");
  engine.command({ type: "chat", lane: "work", message: "继续工作", requestId: randomUUID() });
  await engine.tick();
  expect(contexts.work[1]!.body).toBe("最新背景");
  expect(contexts.work[1]!.messages.every((message) => !message.body.startsWith("背景"))).toBe(true);
});

it.each(["background", "work"] as const)("stops only %s when both processes are running", async (lane) => {
  const gate = Promise.withResolvers<void>();
  const signals: AbortSignal[] = [];
  const { engine, store } = fixture(async (_config, files, _writable, _prompt, signal) => {
    signals.push(signal);
    await Promise.race([gate.promise, new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
    return reply(files);
  });
  engine.command({ type: "research", kind: "background", requestId: randomUUID() });
  engine.command({ type: "research", kind: "daily", requestId: randomUUID() });
  const running = engine.tick();
  expect(engine.snapshot().research.active.sort()).toEqual(["background", "daily"]);
  expect(() => engine.command({ type: "cancel" })).toThrow("请选择");
  engine.command({ type: "cancel", lane });
  await vi.waitFor(() => expect(store.system().runs.filter((run) => run.status === "interrupted")).toHaveLength(1));
  expect(signals.filter((signal) => signal.aborted)).toHaveLength(1);
  expect(engine.snapshot().busy).toBe(true);
  gate.resolve();
  await running;
  expect(store.system().runs.filter((run) => run.status === "succeeded")).toHaveLength(1);
  expect(store.system().research[lane === "background" ? "daily" : "background"].blockedReason).toBeNull();
});

it("keeps background research running when work is created or approved, preserving the new work queue", async () => {
  const gate = Promise.withResolvers<void>();
  let backgroundSignal: AbortSignal | undefined;
  const { engine, store } = fixture(async (_config, files, _writable, _prompt, signal) => {
    backgroundSignal = signal;
    await gate.promise;
    files.set("background/SUMMARY.md", "背景结果");
    return reply(files);
  });
  engine.command({ type: "research", kind: "background", requestId: randomUUID() });
  const running = engine.tick();
  const task = create(engine);
  store.update((_state, files) => files.set(cardFile(task.id), encodeCard({ title: task.title, status: "review", request: { kind: "approval", question: "批准具体方案" } }, "内容")));
  engine.command({ type: "approve", taskId: task.id, digest: engine.snapshot().tasks[0]!.digest, requestId: randomUUID() });
  expect(backgroundSignal?.aborted).toBe(false);
  gate.resolve();
  await running;
  expect(store.system().runs[0]!.status).toBe("succeeded");
  expect(store.system().queue[0]?.taskIds).toEqual([task.id]);
  expect(store.system().queue).toHaveLength(1);
  expect(store.system().approvals).toHaveLength(0);
  expect(store.system().messages.findLast((item) => item.review)?.review?.status).toBe("pending");
  expect(store.system().research.daily.lastCompletedAt).toBeNull();
});

it("rejects cross-lane file edits without changing the other lane's published files", async () => {
  const { engine, store } = fixture(async (_config, files) => {
    files.set("background/SUMMARY.md", "不应覆盖背景");
    files.set("assistant/ATTENTION.md", "未发布工作");
    return reply(files);
  });
  engine.command({ type: "chat", lane: "work", message: "处理工作", requestId: randomUUID() });
  await engine.tick();
  expect(store.system().runs[0]!.status).toBe("failed");
  expect(store.raw("background/SUMMARY.md")).toBe("");
  expect(store.files().has("assistant/ATTENTION.md")).toBe(false);
});

it("does not immediately restart a card after stopping the work process", async () => {
  const turn = vi.fn<FileTurn>(async (_config, _files, _writable, _prompt, signal) => {
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    throw new Error("unreachable");
  });
  const { engine, store } = fixture(turn);
  create(engine);
  const running = engine.tick();
  engine.command({ type: "cancel", lane: "work" });
  await running;
  await engine.tick();
  expect(turn).toHaveBeenCalledTimes(1);
  expect(store.system().errors["PIL-1"]).toContain("停止本轮");
});

it("migrates a legacy shared research failure only to its own schedule", () => {
  const { engine, store } = fixture();
  store.updateSystem((state) => {
    state.research.blockedReason = "旧版背景调研失败";
    state.runs.push({ id: randomUUID(), scope: "frontdesk", research: "background", status: "failed", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), detail: "旧版背景调研失败" });
  });
  engine.recover();
  expect(store.system().research.blockedReason).toBeNull();
  expect(store.system().research.background.blockedReason).toBe("旧版背景调研失败");
  expect(store.system().research.daily.blockedReason).toBeNull();
});


it("keeps exactly two persistent sessions, separates conversations, and never leaks unsent reviews into either prompt", async () => {
  const seen: { lane: string; sessionId: string; otherSessionId: string; messages: { body: string }[]; conversation: { body: string }[] }[] = [];
  const turn = vi.fn<FileTurn>(async (_config, files) => {
    const input = JSON.parse(textContent(files.get("INTERACTIONS.md")!)); seen.push(input);
    expect(input.messages.some((item: { body: string }) => item.body === "还没提交的修改")).toBe(false);
    expect(files.has(cardFile("PIL-1"))).toBe(true);
    expect(files.has("background/SUMMARY.md")).toBe(true);
    return reply(files);
  });
  const { engine, store } = fixture(turn);
  store.update((_state, files) => files.set(cardFile("PIL-1"), encodeCard({ title: "测试", status: "waiting", request: null }, "工作结果")));
  const sessions = store.system().sessions;
  expect(sessions.work).not.toBe(sessions.background);
  engine.command({ type: "note", taskId: "PIL-1", message: "还没提交的修改", requestId: randomUUID() });
  engine.command({ type: "chat", lane: "work", message: "只讨论工作", requestId: randomUUID() });
  engine.command({ type: "chat", lane: "background", message: "只修改背景", requestId: randomUUID() });
  await engine.tick();
  expect(seen).toHaveLength(2);
  for (const input of seen) {
    const lane = input.lane as "work" | "background";
    expect(input.sessionId).toBe(sessions[lane]);
    expect(input.otherSessionId).toBe(sessions[lane === "work" ? "background" : "work"]);
    expect(input.conversation.some((item) => item.body === (lane === "work" ? "只修改背景" : "只讨论工作"))).toBe(false);
  }
  const reopened = new Store(store.directory);
  const restored = new Engine(reopened, () => ({ kind: "codex", executable: "/controlled/no-real-cli" }), undefined, turn);
  restored.recover();
  expect(reopened.system().sessions).toEqual(sessions);
  restored.command({ type: "chat", lane: "work", message: "接着聊", requestId: randomUUID() });
  await restored.tick();
  expect(seen.at(-1)?.sessionId).toBe(sessions.work);
  expect(seen.at(-1)?.messages.some((item) => item.body === "只讨论工作")).toBe(true);
  expect(reopened.system().messages.filter((item) => item.review?.status === "pending")).toHaveLength(1);
});

it("revalidates saved approval before batch submission and allows replacing or withdrawing it", () => {
  const { engine, store } = fixture();
  store.update((_state, files) => files.set(cardFile("PIL-1"), encodeCard({ title: "审批", status: "review", request: { kind: "approval", question: "发送这版内容？" } }, "第一版")));
  const approve = () => engine.command({ type: "approve", taskId: "PIL-1", digest: engine.snapshot().tasks[0]!.digest, requestId: randomUUID() });
  approve();
  store.update((_state, files) => files.set("tasks/PIL-1/draft.md", "改变的内容"));
  expect(() => engine.command({ type: "research", kind: "daily", requestId: randomUUID() })).toThrow("方案已有更新");
  expect(store.system().approvals).toEqual([]);
  expect(store.system().queue).toEqual([]);
  approve();
  expect(store.system().messages.filter((item) => item.review?.status === "pending")).toHaveLength(1);
  engine.command({ type: "review_discard", taskId: "PIL-1", requestId: randomUUID() });
  expect(store.system().messages.filter((item) => item.review?.status === "pending")).toHaveLength(0);
  approve();
  engine.command({ type: "research", kind: "daily", requestId: randomUUID() });
  expect(store.system().approvals).toHaveLength(1);
  expect(store.system().approvals[0]?.digest).toBe(engine.snapshot().tasks[0]!.digest);
});

it("does not start work from todo states, file edits, event notifications or saved new cards", async () => {
  const turn = vi.fn<FileTurn>(async (_config, files) => reply(files));
  const { engine, store } = fixture(turn);
  store.update((state, files) => {
    state.research.daily.enabled = false; state.research.background.enabled = false;
    files.set(cardFile("PIL-1"), encodeCard({ title: "待推进", status: "todo", request: null }, "原始资料"));
    state.queue.push({ kind: "event", id: randomUUID(), scope: "PIL-1", message: "文件有变化" });
  });
  await engine.tick();
  store.update((_state, files) => files.set("tasks/PIL-1/notes.md", "新的资料"));
  engine.command({ type: "create", requestId: randomUUID(), title: "新事项", context: "先保存" });
  await engine.tick();
  expect(turn).not.toHaveBeenCalled();
  engine.recover();
  expect(store.system().queue).toEqual([]);
  engine.command({ type: "research", kind: "daily", requestId: randomUUID() });
  await engine.tick();
  expect(turn).toHaveBeenCalledTimes(1);
});

it("hands review back to AI when feedback is saved, preserves the published file, and restores review on withdrawal", async () => {
  const gate = Promise.withResolvers<void>();
  const turn = vi.fn<FileTurn>(async (_config, files) => {
    await gate.promise;
    files.set(cardFile("REVIEW-1"), encodeCard({ title: "待审核事项", status: "review", request: { kind: "approval", question: "新方案是否可行？" } }, "已按本批意见修改。"));
    return reply(files, "已处理反馈，请看新的方案。");
  });
  const { store, engine } = fixture(turn);
  store.update((state, files) => {
    state.research.daily.enabled = false;
    state.research.background.enabled = false;
    files.set(cardFile("REVIEW-1"), encodeCard({ title: "待审核事项", status: "review", request: { kind: "approval", question: "旧方案是否可行？" } }, "上一版方案"));
  });
  const published = store.raw(cardFile("REVIEW-1"));
  const save = (message: string) => engine.command({ type: "note", taskId: "REVIEW-1", requestId: randomUUID(), message });
  const withdraw = () => engine.command({ type: "review_discard", taskId: "REVIEW-1", requestId: randomUUID() });
  save("请修改方案");
  expect(engine.snapshot().tasks[0]).toMatchObject({ status: "awaiting_ai", queued: false, request: null });
  expect(store.raw(cardFile("REVIEW-1"))).toBe(published);
  expect(new Engine(new Store(store.directory)).snapshot().tasks[0]).toMatchObject({ status: "awaiting_ai", request: null });
  await engine.tick();
  expect(turn).not.toHaveBeenCalled();
  withdraw();
  expect(engine.snapshot().tasks[0]).toMatchObject({ status: "review", request: { question: "旧方案是否可行？" } });
  save("请修改方案后再给我确认");
  engine.command({ type: "research", kind: "daily", requestId: randomUUID() });
  expect(engine.snapshot().tasks[0]).toMatchObject({ status: "queued", queued: true, request: null });
  const running = engine.tick();
  expect(engine.snapshot().tasks[0]).toMatchObject({ status: "running", request: null });
  save("下一轮再补充这条");
  gate.resolve();
  await running;
  expect(engine.snapshot().tasks[0]).toMatchObject({ status: "awaiting_ai", queued: false, request: null });
  expect(parseCard(store.raw(cardFile("REVIEW-1"))!).header.request?.question).toBe("新方案是否可行？");
  withdraw();
  expect(engine.snapshot().tasks[0]).toMatchObject({ status: "review", request: { question: "新方案是否可行？" } });
  expect(store.system().approvals).toEqual([]);
});

it("returns to user review only after the AI publishes a new decision, and suppresses stale approval on failure", async () => {
  let fail = false;
  const { store, engine } = fixture(async (_config, files) => {
    if (fail) throw new Error("受控失败");
    files.set(cardFile("REVIEW-1"), encodeCard({ title: "待审核事项", status: "review", request: { kind: "approval", question: "请确认修改后的方案" } }, "新方案"));
    return reply(files);
  });
  store.update((state, files) => {
    state.research.daily.enabled = false;
    state.research.background.enabled = false;
    files.set(cardFile("REVIEW-1"), encodeCard({ title: "待审核事项", status: "review", request: { kind: "approval", question: "旧方案？" } }, "旧方案"));
  });
  const advance = async () => {
    engine.command({ type: "note", taskId: "REVIEW-1", requestId: randomUUID(), message: "修改这版方案" });
    engine.command({ type: "research", kind: "daily", requestId: randomUUID() });
    await engine.tick();
  };
  await advance();
  expect(engine.snapshot().tasks[0]).toMatchObject({ status: "review", request: { question: "请确认修改后的方案" } });
  fail = true;
  await advance();
  expect(engine.snapshot().tasks[0]).toMatchObject({ status: "blocked", request: null });
});

it("validates all saved approvals atomically before a scheduled batch starts", async () => {
  const turn = vi.fn<FileTurn>(async (_config, files) => reply(files));
  const { store, engine } = fixture(turn);
  store.update((state, files) => {
    state.research.background.enabled = false;
    state.research.daily.nextAt = "2026-09-18T02:30:00.000Z";
    for (const id of ["A", "B"]) files.set(cardFile(id), encodeCard({ title: id, status: "review", request: { kind: "approval", question: "批准当前方案？" } }, "当前方案"));
  });
  for (const task of engine.snapshot().tasks) engine.command({ type: "approve", taskId: task.id, digest: task.digest, requestId: randomUUID() });
  store.update((_state, files) => files.set("tasks/B/draft.md", "审批之后方案变化"));
  vi.setSystemTime(new Date("2026-09-18T02:30:00Z"));
  await engine.tick();
  expect(turn).not.toHaveBeenCalled();
  expect(store.system().approvals).toEqual([]);
  expect(store.system().runs).toEqual([]);
  expect(store.system().messages.filter((item) => item.review?.status === "pending")).toHaveLength(2);
  expect(engine.snapshot().tasks.every((task) => task.status === "awaiting_ai")).toBe(true);
  expect(engine.snapshot().runtime.error).toContain("B 的方案已有更新");
  engine.command({ type: "review_discard", taskId: "B", requestId: randomUUID() });
  await engine.tick();
  expect(turn).toHaveBeenCalledTimes(1);
  expect(store.system().approvals.map((item) => item.taskId)).toEqual(["A"]);
  expect(store.system().runs[0]).toMatchObject({ source: "automatic", taskIds: ["A"], status: "succeeded" });
});
