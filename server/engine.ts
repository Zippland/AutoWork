import { randomUUID } from "node:crypto";
import { readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type Command,
  type ModelConnection,
  type PilotTask,
  type Snapshot,
  type SystemState,
  type ResearchKind,
  type ResearchSettings,
  type ExecutionLane,
  executionLane,
} from "../core";
import {
  inResearchWindow,
  nextResearchWindow,
  researchCalendarError,
} from "../core/research-window";
import { cardFile, directoryDigest, encodeCard, parseCard, sameContent, textContent, type FileMap } from "./documents";
import { type CliModelConfig } from "./cli-model";
import { FileTurnError, runFileTurn, validateTurn, type FileTurn } from "./file-agent";
import { SUMMARY_FILE, modelFile, validateFiles } from "./workspace-files";
import { Store } from "./store";
const now = () => new Date().toISOString();
const disconnected = (): ModelConnection => ({
  provider: null,
  label: "模型未连接",
  status: "disconnected",
  verifiedAt: null,
  error: null,
  available: [],
});
const message = (
  state: SystemState,
  scope: string,
  body: string,
  role: "user" | "assistant" = "user",
) => state.messages.push({ id: randomUUID(), scope, body, role, at: now() });
export class Engine {
  readonly intervalMs = 5000;
  private active: Record<ExecutionLane, {
    scope: string;
    taskIds?: string[];
    controller: AbortController;
    research?: ResearchKind;
    cancelled?: boolean;
  } | null> = { work: null, background: null };
  private stopping = false;
  private wakeRequested = new Set<ExecutionLane>();
  wake() {
    this.wakeRequested.add("work");
    this.wakeRequested.add("background");
    setImmediate(() => { void this.tick(); });
  }
  private errors: Partial<Record<ExecutionLane, string>> = {};
  constructor(
    readonly store: Store,
    private model: () => CliModelConfig | null = () => null,
    private connection: () => ModelConnection = disconnected,
    private turn: FileTurn = runFileTurn,
  ) {}
  recover() {
    this.store.updateSystem((state) => {
      // File/event notifications are no longer an execution trigger.
      state.queue = state.queue.filter((item) => item.kind === "user");
      // Migrate the old shared research pause without blocking the other lane.
      if (state.research.blockedReason) {
        const failed = state.runs.findLast((run) => run.research && run.status !== "succeeded");
        if (failed?.research) state.research[failed.research].blockedReason = state.research.blockedReason;
        state.research.blockedReason = null;
      }
      for (const kind of ["daily", "background"] as const) {
        const at = state.research[kind].nextAt;
        state.research[kind].nextAt = at
          ? nextResearchWindow(new Date(Math.max(Date.now(), Date.parse(at))), state.research.settings)
          : this.nextResearchAt(kind);
      }
      for (const run of state.runs.filter(
        (item) => item.status === "running",
      )) {
        run.status = "interrupted";
        run.finishedAt = now();
        run.detail = "服务在运行期间中断；请确认后继续。";
        state.errors[run.scope] = run.detail;
        for (const id of run.taskIds || []) state.errors[id] = run.detail;
        if (run.research) state.research[run.research].blockedReason = run.detail;
        if (["frontdesk", "background"].includes(run.scope))
          message(state, executionLane(run) === "background" ? "background" : run.scope, run.detail, "assistant");
      }
    });
  }
  private nextResearchAt(kind: ResearchKind, settings: ResearchSettings = this.store.system().research.settings) {
    return nextResearchWindow(new Date(Date.now() + (kind === "daily" ? settings.dailyMinutes : settings.backgroundMinutes) * 60_000), settings);
  }
  private submitReviews(state: SystemState, files: FileMap) {
    const reviews = state.messages.filter((item) => item.review?.status === "pending");
    // Validate the whole batch before submitting any feedback or authorization.
    for (const item of reviews) {
      if (!files.has(cardFile(item.scope))) throw new Error(`${item.scope} 已不存在，请撤回该事项的待推进意见。`);
      if (item.review?.action === "approve" && directoryDigest(files, `tasks/${item.scope}/`) !== item.review.digest)
        throw new Error(`${item.scope} 的方案已有更新，请重新查看并批准，或撤回待推进意见。其他意见已保存。`);
    }
    for (const item of reviews) {
      item.review!.status = "submitted";
      if (item.review!.action === "approve") state.approvals.push({
        id: item.id, taskId: item.scope, digest: item.review!.digest!, document: item.review!.document!, at: item.at,
      });
    }
    return reviews;
  }
  stop() {
    this.stopping = true;
    for (const active of Object.values(this.active)) active?.controller.abort(new Error("服务已停止，本轮未发布。"));
  }
  snapshot(): Snapshot {
    const system = this.store.system();
    const schedule = (kind: ResearchKind) => ({
      ...system.research[kind],
      nextAt: system.research[kind].nextAt
        ? nextResearchWindow(new Date(Math.max(Date.now(), Date.parse(system.research[kind].nextAt!))), system.research.settings)
        : null,
    });
    let files = new Map<string, string | Buffer>();
    let issues: { file: string; message: string }[] = [];
    try {
      files = this.store.files();
      issues = validateFiles(files);
    } catch (error) {
      issues = [{ file: "workspace", message: String(error) }];
    }
    const tasks: PilotTask[] = [];
    const pendingReviews = new Set(system.messages.filter((item) => item.review?.status === "pending").map((item) => item.scope));
    for (const [name, raw] of files)
      if (/^tasks\/[^/]+\/SUMMARY\.md$/.test(name)) {
        try {
          const id = name.split("/")[1]!;
          const { header, body } = parseCard(raw);
          const prefix = `tasks/${id}/`;
          const names = [...files.keys()].filter((file) =>
            file.startsWith(prefix),
          );
          const updatedAt = new Date(
            Math.max(
              ...names.map(
                (file) => statSync(join(this.store.directory, file)).mtimeMs,
              ),
            ),
          ).toISOString();
          const queued = system.queue.some((item) => item.scope === id || item.taskIds?.includes(id));
          const running = this.active.work?.scope === id || !!this.active.work?.taskIds?.includes(id);
          const waitingForAI = pendingReviews.has(id) || queued || running;
          tasks.push({
            id,
            title: header.title,
            project: typeof header.project === "string" ? header.project : null,
            category: header.category ?? null,
            body,
            // The document is the AI's last publication; host-owned feedback
            // decides whose turn it is until the next batch has been handled.
            request: waitingForAI || system.errors[id] ? null : header.request,
            digest: directoryDigest(files, prefix),
            updatedAt,
            files: names,
            error: system.errors[id] ?? null,
            queued,
            demo: header.demo ?? false,
            status:
              running
                ? "running"
                : queued
                  ? "queued"
                  : pendingReviews.has(id)
                  ? "awaiting_ai"
                  : system.errors[id]
                  ? "blocked"
                  : header.status,
          });
        } catch {
          /* The invalid card is already reported in fileIssues. */
        }
      }
    return {
      reviewMode: "batch",
      onboardingCompletedAt: system.onboardingCompletedAt,
      tasks,
      attention: typeof files.get("assistant/ATTENTION.md") === "string" ? textContent(files.get("assistant/ATTENTION.md")!) : "",
      background: {
        body: typeof files.get(SUMMARY_FILE) === "string" ? textContent(files.get(SUMMARY_FILE)!) : "",
        updatedAt: files.has(SUMMARY_FILE)
          ? statSync(
              join(this.store.directory, SUMMARY_FILE),
            ).mtime.toISOString()
          : null,
      },
      messages: system.messages,
      runs: system.runs,
      paused: system.paused,
      busy: Object.values(this.active).some(Boolean),
      activeScopes: Object.values(this.active).flatMap((active) => active ? [active.scope] : []),
      research: {
        settings: system.research.settings,
        blockedReason: system.research.blockedReason,
        daily: schedule("daily"),
        background: schedule("background"),
        calendarError: researchCalendarError(new Date(), system.research.settings),
        active: Object.values(this.active).flatMap((active) => active?.research ? [active.research] : []),
        queued: [...new Set(system.queue.flatMap((item) =>
          executionLane(item) === "work" ? ["daily" as const] : item.research ? [item.research] : [],
        ))],
      },
      runtime: {
        workspace: this.store.directory,
        modelConnection: this.connection(),
        fileIssues: issues,
        error: Object.values(this.errors).join("；") || null,
      },
    };
  }
  command(command: Exclude<Command, { type: "model_connect" }>) {
    // Saved reviews stay host-owned until manual or scheduled advancement.
    if (
      "requestId" in command &&
      this.store.system().receipts.includes(command.requestId)
    )
      return;
    if (command.type === "onboarding_complete") {
      if (this.active.background || this.store.system().queue.some((item) => executionLane(item) === "background"))
        throw new Error("请等当前背景整理结束后再进入工作台。");
      this.store.update((state, files) => {
        if (!textContent(files.get(SUMMARY_FILE) || "").trim())
          throw new Error("请先完成背景调研，再进入工作台。");
        state.receipts.push(command.requestId);
        if (!state.onboardingCompletedAt) {
          state.onboardingCompletedAt = now();
          for (const kind of ["daily", "background"] as const)
            state.research[kind].nextAt = this.nextResearchAt(kind, state.research.settings);
        }
      });
      return;
    }
    if (command.type === "research" && command.kind === "daily" && !this.store.system().onboardingCompletedAt)
      throw new Error("请先完成背景调研并进入工作台，再开始日常巡检。");
    if (command.type === "research_settings") {
      this.store.updateSystem((state) => {
        state.receipts.push(command.requestId);
        state.research.settings = command.settings;
        for (const kind of ["daily", "background"] as const) state.research[kind].nextAt = this.nextResearchAt(kind, command.settings);
      });
      return;
    }
    if (command.type === "cancel") {
      const lanes = command.lane ? [command.lane] : (["work", "background"] as const).filter((lane) => this.active[lane]);
      if (lanes.length > 1) throw new Error("请选择要停止的背景调研或工作推进。");
      for (const lane of lanes) {
        const active = this.active[lane];
        if (active) { active.cancelled = true; active.controller.abort(new Error("你已停止本轮处理。")); }
      }
      return;
    }
    if (command.type === "pause") {
      this.store.updateSystem((state) => {
        state.paused = command.paused;
      });
      for (const active of Object.values(this.active)) active?.controller.abort(new Error("自动推进设置已更改，本轮已停止。"));
      this.errors = {};
      return;
    }
    if (command.type === "research_schedule" || command.type === "research") {
      this.store.updateSystem((state) => {
        state.receipts.push(command.requestId);
        if (command.type === "research_schedule") {
          state.research[command.kind].enabled = command.enabled;
          if (command.enabled) {
            state.research[command.kind].blockedReason = null;
            state.research[command.kind].nextAt = this.nextResearchAt(
              command.kind,
            );
          }
          return;
        }
        if (
          (command.kind === "daily"
            ? this.active.work || state.queue.some((item) => executionLane(item) === "work")
            : this.active.background?.research === "background" || state.queue.some((item) => item.research === "background"))
        )
          return;
        const reviews = command.kind === "daily" ? this.submitReviews(state, this.store.files()) : [];
        state.research[command.kind].blockedReason = null;
        const scope = command.kind === "background" ? "background" : "frontdesk";
        const body =
          command.kind === "background"
            ? "请全面调研并刷新我的背景资料。"
            : `请推进整个工作台：先读最新背景与全部事项，${reviews.length ? `优先处理本批 ${reviews.length} 条审阅意见（${[...new Set(reviews.map((item) => item.scope))].join("、")}），` : ""}查看今天的整体情况，并按当前计划推进已交办或已授权的事项；需要我决定的内容准备好后交给我审核。`;
        message(state, scope, body);
        state.queue.push({
          kind: "user",
          id: command.requestId,
          scope,
          message: body,
          research: command.kind,
          ...(reviews.length ? { taskIds: [...new Set(reviews.map((item) => item.scope))], reviewIds: reviews.map((item) => item.id) } : {}),
        });
      });
      delete this.errors[command.kind === "background" ? "background" : "work"];
      return;
    }
    if (command.type === "note" || command.type === "approve" || command.type === "review_discard" || (command.type === "task" && command.action === "resume")) {
      this.store.updateSystem((state) => {
        if (command.type === "review_discard") {
          state.receipts.push(command.requestId);
          for (const item of state.messages) if (item.scope === command.taskId && item.review?.status === "pending") item.review.status = "cancelled";
          return;
        }
        const files = this.store.files();
        const raw = files.get(cardFile(command.taskId));
        if (!raw) throw new Error("事项不存在。");
        const { header } = parseCard(raw);
        if ("digest" in command && directoryDigest(files, `tasks/${command.taskId}/`) !== command.digest)
          throw new Error("内容已有更新，请重新查看后再操作。");
        if (command.type === "approve" && (header.status !== "review" || header.request?.kind !== "approval"))
          throw new Error("这件事当前没有待批准的请求。");
        state.receipts.push(command.requestId);
        if (command.type === "approve") for (const item of state.messages) if (item.scope === command.taskId && item.review?.status === "pending" && item.review.action === "approve") item.review.status = "cancelled";
        state.messages.push({
          id: command.requestId, scope: command.taskId, role: "user", at: now(),
          body: command.type === "note" ? command.message : command.type === "approve" ? `用户通过审批按钮批准了此版本的请求：${header.request!.question}` : "用户要求恢复或继续推进此事项。此操作不代表批准外部动作。",
          review: { status: "pending", action: command.type === "task" ? "resume" : command.type, ...(command.type === "approve" ? { digest: command.digest, document: textContent(raw) } : {}) },
        });
      });
      return;
    }
    const lane: ExecutionLane = command.type === "chat" ? command.lane ?? (this.store.system().onboardingCompletedAt ? "work" : "background") : "work";
    this.store.update((state, files) => {
      state.receipts.push(command.requestId);
      if (command.type === "create") {
        let number = 1;
        while (files.has(cardFile(`PIL-${number}`))) number++;
        const id = `PIL-${number}`;
        files.set(
          cardFile(id),
          encodeCard(
            { title: command.title, status: "todo", request: null, category: "commitment" },
            command.context,
          ),
        );
        message(state, id, `新事项：${command.title}\n${command.context}`);
        state.messages.at(-1)!.review = { status: "pending", action: "resume" };
        return;
      }
      if (command.type === "chat") {
        const scope = lane === "background" ? "background" : "frontdesk";
        if (lane === "background" && command.contextId) throw new Error("请在工作对话中讨论事项。");
        if (command.contextId && !files.has(cardFile(command.contextId)))
          throw new Error("引用的事项不存在。");
        message(state, scope, command.message);
        if (command.contextId)
          state.messages.at(-1)!.contextId = command.contextId;
        delete state.errors[scope];
        state.queue.push({
          kind: "user",
          id: command.requestId,
          scope,
          message: command.message,
        });
        return;
      }
      const name = cardFile(command.taskId);
      const raw = files.get(name);
      if (!raw) throw new Error("事项不存在。");
      const { header, body } = parseCard(raw);
      if (
        "digest" in command &&
        directoryDigest(files, `tasks/${command.taskId}/`) !== command.digest
      )
        throw new Error("内容已有更新，请重新查看后再操作。");
      {
        if (command.action === "archive") {
          if (header.status !== "done")
            throw new Error("事项尚未提交验收，不能验收归档。");
          state.acceptances.push({
            id: command.requestId,
            taskId: command.taskId,
            digest: command.digest,
            document: textContent(raw),
            at: now(),
          });
        }
        header.status =
          command.action === "pause"
            ? "paused"
            : command.action === "archive"
              ? "archived"
              : "todo";
        header.request = null;
        message(
          state,
          command.taskId,
          command.action === "pause"
            ? "用户暂停了事项。"
            : command.action === "archive"
              ? "用户验收通过了此版本的交付，并归档事项。"
              : "用户要求继续推进。此操作不代表批准外部动作。",
        );
      }
      const taskReviewIds = new Set(state.messages.filter((item) => item.scope === command.taskId && item.review).map((item) => item.id));
      state.queue = state.queue.filter((item) => item.scope !== command.taskId).map((item) => item.taskIds?.includes(command.taskId) ? {
        ...item,
        taskIds: item.taskIds.filter((id) => id !== command.taskId),
        reviewIds: item.reviewIds?.filter((id) => !taskReviewIds.has(id)),
        message: `${item.message}\n用户随后已${command.action === "archive" ? "验收归档" : "暂停"} ${command.taskId}，本轮不再推进该事项。`,
      } : item);
      for (const item of state.messages) if (item.scope === command.taskId && item.review?.status === "pending") item.review.status = "cancelled";
      delete state.errors[command.taskId];
      files.set(name, encodeCard(header, body));
    });
    if (command.type !== "create") this.active[lane]?.controller.abort(new Error("新的用户操作中断了本轮处理。"));
    delete this.errors[lane];
  }
  async tick() {
    await Promise.all([this.tickLane("background"), this.tickLane("work")]);
  }
  private async tickLane(lane: ExecutionLane) {
    if (this.active[lane] || this.stopping) return;
    this.wakeRequested.delete(lane);
    const config = this.model();
    if (!config) return;
    let produced: FileMap | null = null;
    let scope = "",
      runId = "";
    try {
      const system = this.store.system();
      const original = this.store.files();
      const issues = validateFiles(original);
      if (issues.length)
        throw new Error(
          issues.map((issue) => `${issue.file}: ${issue.message}`).join("\n"),
        );
      delete this.errors[lane];
      const eligibleQueue = system.queue.filter((item) => item.kind === "user" && executionLane(item) === lane && (
        !!system.onboardingCompletedAt || (lane === "background" && item.kind === "user")
      ));
      const queued =
        eligibleQueue.find((item) => item.kind === "user" && item.scope === "frontdesk") ||
        eligibleQueue.find((item) => item.kind === "user");
      const scheduledResearch =
        queued?.research ??
        (!queued && system.onboardingCompletedAt && !system.paused && inResearchWindow(new Date(), system.research.settings)
          ? ([lane === "background" ? "background" : "daily"] as const).find(
              (kind) =>
                !system.research[kind].blockedReason && system.research[kind].enabled &&
                system.research[kind].nextAt &&
                Date.parse(system.research[kind].nextAt!) <= Date.now(),
            )
          : undefined);
      const automatic = queued?.kind !== "user";
      if (queued) scope = lane === "background" ? "background" : queued.scope;
      else if (scheduledResearch) scope = lane === "background" ? "background" : "frontdesk";
      if (!scope) return;
      // Every work wake-up reviews the board; a card is the focus, not a separate scope.
      const research = lane === "work" ? "daily" : scheduledResearch;
      if (
        automatic &&
        system.runs.filter(
          (run) =>
            run.source !== "user" &&
            run.startedAt.startsWith(now().slice(0, 10)),
        ).length >= 96
      )
        throw new Error(
          "今日自动运行已达到 96 次（UTC），明日恢复。你仍可直接对话或手动刷新。",
        );
      const controller = new AbortController();
      let taskIds = queued?.taskIds ?? (["frontdesk", "background"].includes(scope) ? [] : [scope]);
      let reviewIds = queued?.reviewIds ?? [];
      const nextRunId = randomUUID();
      this.store.updateSystem((state) => {
        if (automatic && lane === "work") {
          const reviews = this.submitReviews(state, original);
          taskIds = [...new Set(reviews.map((item) => item.scope))];
          reviewIds = reviews.map((item) => item.id);
        }
        if (queued)
          state.queue = state.queue.filter((item) => item.id !== queued.id);
        if (research)
          state.research[research].nextAt = this.nextResearchAt(research);
        state.runs.push({
          id: nextRunId,
          sessionId: state.sessions[lane],
          scope,
          taskIds,
          startedAt: now(),
          finishedAt: null,
          status: "running",
          detail: "",
          ...(research ? { research } : {}),
          source: automatic ? "automatic" : "user",
        });
      });
      runId = nextRunId;
      this.active[lane] = { scope, controller, research, taskIds };
      // Two independent contexts; cards remain files within the work lane.
      const taskId = ["frontdesk", "background"].includes(scope) ? null : scope;
      const writable = lane === "background" ? ["background/"] : ["assistant/", "tasks/"];
      const owned = (files: FileMap) => new Map([...files].filter(([name]) => writable.some((prefix) => name.startsWith(prefix))));
      const supplied = new Map(original);
      // Host-owned interaction records are reference context, never model-editable files.
      const relevant = this.store.system();
      supplied.set(
        "INTERACTIONS.md",
        JSON.stringify(
          {
            lane,
            sessionId: relevant.sessions[lane],
            otherSessionId: relevant.sessions[lane === "work" ? "background" : "work"],
            currentTaskId: taskId,
            priorityTaskIds: taskIds,
            submittedReviews: relevant.messages.filter((item) => reviewIds.includes(item.id)),
            backgroundReadAt: now(),
            onboardingCompletedAt: relevant.onboardingCompletedAt,
            research: relevant.research,
            messages: relevant.messages.filter((item) => (!item.review || item.review.status === "submitted") && executionLane(item) === lane).slice(-100),
            conversation: relevant.messages.filter((item) => (!item.review || item.review.status === "submitted") && item.scope === (lane === "work" ? "frontdesk" : "background")).slice(-100),
            approvals: lane === "work" ? relevant.approvals : [],
            acceptances: lane === "work" ? relevant.acceptances : [],
            runs: relevant.runs.filter((item) => executionLane(item) === lane).slice(-20),
          },
          null,
          2,
        ),
      );
      const planNames = lane === "background" ? ["background"] : ["work", ...(research ? [research] : [])];
      const plans = planNames.map((name) => {
        const path = join(dirname(this.store.directory), `.agents/skills/taskpilot-files/prompts/${name}.md`);
        return `Plan file: ${path}\n${readFileSync(path, "utf8")}`;
      });
      // Only execution context is generated here; the model-maintained plan is read anew every turn.
      const instruction = [
        `Execution lane: ${lane}. Background research and work run in independent CLI processes and conversations.`,
        lane === "work" ? "Before planning or acting, read background/SUMMARY.md from this turn’s fresh workspace copy. It was loaded from the latest published background at the start of this run; do not rely on remembered background. Follow its references as needed. Background may update independently; next work turn reads it again." : "Refresh background/SUMMARY.md and freely organize background/ evidence. Work proceeds independently; do not update cards or assistant/ in this lane. Read their published files as context when useful.",
        "Read INTERACTIONS.md for this lane’s conversation, scope and actual authorization records.",
        "TaskPilot has exactly two persistent logical sessions: work and background, identified by sessionId. Each has its own saved conversation and run history. CLI processes execute bounded turns; files and host history preserve continuity across restarts or harness changes. You know the other session exists and can read its published results from the shared board/files, but do not impersonate it or write its directories. Respond to the current request without re-executing earlier requests.",
        taskIds.length ? `Priority items: ${taskIds.map((id) => `tasks/${id}/`).join(", ")}. These items are the first priority, not the boundary of this run. Review the whole board and latest background, handle all submitted feedback, and advance other relevant actionable work under existing authorization. Reuse recent verified evidence and investigate further only where needed. Record each item's outcome in its files and summarize outcomes by item in the final reply.` : "Selected scope: the shared workspace.",
        "Only submitted reviews in INTERACTIONS.md belong to this run. Saved pending reviews visible on the live board are for a future batch; do not read or act on them through other tools. Never interpret clicking workbench advance as approval of an external action. Preserve existing approval boundaries, and reconcile any changed proposal with its exact recorded approval before acting.",
        queued ? `${queued.kind === "user" ? "Current user message" : "Host notification, not a new user instruction"}: ${JSON.stringify(queued.message)}` : "This is an automatic continuation, not new user authorization.",
        research ? `Research: ${research}. Trigger: ${automatic ? "automatic; if there is no actionable or meaningful change, final reply must be exactly NO_UPDATE" : "manual; always summarize findings and actual coverage"}. Previous completed research: ${system.research[research].lastCompletedAt || "none"}. Local time: ${new Date().toString()}.` : "",
        ...plans,
      ].filter(Boolean).join("\n\n");
      const result = await this.turn(
        config,
        new Map(supplied),
        writable,
        instruction,
        controller.signal,
        {
          runId,
          onProgress: (stage) => {
            this.store.updateSystem((state) => {
              const run = state.runs.find((item) => item.id === runId);
              if (!run || run.status !== "running") return;
              if (run.progress === stage && run.lastActivityAt && Date.now() - Date.parse(run.lastActivityAt) < 1000) return;
              run.progress = stage;
              run.lastActivityAt = now();
            });
          },
        },
      );
      produced = result;
      if (controller.signal.aborted)
        throw new Error("用户操作已更新；本轮未发布。");
      const edited = validateTurn(supplied, result, writable);
      const after = new Map(original);
      for (const name of supplied.keys())
        if (name !== "INTERACTIONS.md" && !edited.has(name)) after.delete(name);
      for (const entry of edited) after.set(...entry);
      if (!result.reply?.trim())
        throw new Error("模型没有返回回复；本轮文件未发布。");
      if (
        taskId &&
        parseCard(after.get(cardFile(scope))!).header.status === "todo" &&
        [...after].every(([name, value]) => sameContent(original.get(name), value)) &&
        after.size === original.size
      )
        throw new Error(
          "本轮未产生文件进展，已停止自动继续。可补充意见后重试。",
        );
      // Compare and publish owned directories only. Concurrent read-only context
      // updates must neither invalidate this lane nor be written back over newer files.
      this.store.publish(owned(original), owned(after), (state) => {
        if (lane === "work") state.queue = state.queue.filter((item) => ["frontdesk", "background"].includes(item.scope) || !original.has(cardFile(item.scope)) || (after.has(cardFile(item.scope)) && parseCard(after.get(cardFile(item.scope))!).header.status === "todo"));
        const run = state.runs.find((item) => item.id === runId)!;
        run.status = "succeeded";
        run.finishedAt = now();
        const silent =
          research && automatic && result.reply!.trim() === "NO_UPDATE";
        run.detail = silent ? "本轮无需要提醒的变化。" : result.reply!;
        if (!silent) {
          message(state, lane === "background" ? "background" : "frontdesk", result.reply!, "assistant");
          if (taskIds.length) state.messages.at(-1)!.contextIds = taskIds;
          if (taskIds.length === 1) state.messages.at(-1)!.contextId = taskIds[0];
        }
        if (research) {
          state.research[research].blockedReason = null;
          state.research[research].lastCompletedAt = now();
          state.research[research].nextAt = this.nextResearchAt(research, state.research.settings);
        }
        delete state.errors[scope];
        for (const id of taskIds) delete state.errors[id];
        for (const id of Object.keys(state.errors)) {
          const prefix = `tasks/${id}/`;
          if (
            directoryDigest(original, prefix) !== directoryDigest(after, prefix)
          )
            delete state.errors[id];
        }
      });
      delete this.errors[lane];
    } catch (error) {
      let detail = error instanceof Error ? error.message : "运行失败。";
      if (runId) {
        let recoveryPath = error instanceof FileTurnError ? error.recoveryPath : null;
        if (!recoveryPath && produced) {
          try {
            recoveryPath = join(dirname(this.store.directory), "recovery", runId);
            mkdirSync(recoveryPath, { recursive: true, mode: 0o700 });
            for (const [name, content] of produced) {
              if (!modelFile(name)) continue;
              const target = join(recoveryPath, "workspace", name);
              mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
              writeFileSync(target, content, { mode: 0o600 });
            }
            writeFileSync(join(recoveryPath, "README.md"), `# 未发布的运行记录\n\n${detail}\n\n保留本轮工作副本，不代表完成或用户验收。请与正式文件核对，避免重复执行外部操作。\n`, { mode: 0o600 });
          } catch { recoveryPath = null; }
        }
        const interrupted = this.active[lane]?.controller.signal.aborted;
        try {
          this.store.updateSystem((state) => {
            const run = state.runs.find((item) => item.id === runId)!;
            if (run.research) {
              state.research[run.research].blockedReason = detail;
              detail = `${run.research === "background" ? "背景调研" : "当天巡检"}未完成：${detail} 此类自动调研已暂停，手动重试成功后恢复。`;
            }
            if (recoveryPath) {
              run.recoveryPath = recoveryPath;
              detail += " 本轮记录与已写入的草稿已保留，尚未发布。";
            }
            run.status = interrupted ? "interrupted" : "failed";
            run.finishedAt = now();
            run.detail = detail;
            if (!interrupted || this.stopping || this.active[lane]?.cancelled) {
              state.errors[scope] = detail;
              for (const id of run.taskIds || []) state.errors[id] = detail;
            }
            message(state, lane === "background" ? "background" : "frontdesk", detail, "assistant");
            if (run.taskIds?.length) state.messages.at(-1)!.contextIds = run.taskIds;
            if (run.taskIds?.length === 1) state.messages.at(-1)!.contextId = run.taskIds[0];
            else if (!["frontdesk", "background"].includes(scope)) state.messages.at(-1)!.contextId = scope;
          });
        } catch (saveError) {
          this.errors[lane] = `${detail}；运行记录保存失败：${String(saveError)}`;
        }
      } else this.errors[lane] = detail;
    } finally {
      this.active[lane] = null;
      if (this.wakeRequested.has(lane) && !this.stopping) {
        this.wakeRequested.delete(lane);
        setImmediate(() => { void this.tick(); });
      }
    }
  }
}
