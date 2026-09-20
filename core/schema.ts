import { z } from "zod";

export const taskCategorySchema = z.enum(["commitment", "proactive"]);
export type TaskCategory = z.infer<typeof taskCategorySchema>;
export const CATEGORY_LABELS: Record<TaskCategory, string> = {
  commitment: "应做事项",
  proactive: "可主动推进",
};

export const cardStatusSchema = z.enum([
  "todo",
  "review",
  "done",
  "paused",
  "waiting",
  "archived",
]);
export const requestSchema = z.object({
  kind: z.enum(["input", "approval"]),
  question: z.string().trim().min(1).max(20000),
});
export const cardHeaderSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    status: cardStatusSchema,
    request: requestSchema.nullable().default(null),
    category: taskCategorySchema.optional(),
    demo: z.boolean().optional(),
  })
  .passthrough();
export const executionLaneSchema = z.enum(["work", "background"]);
export type ExecutionLane = z.infer<typeof executionLaneSchema>;
export function executionLane(item: { scope: string; research?: string }): ExecutionLane {
  return item.scope === "background" || item.research === "background" ? "background" : "work";
}
export const messageSchema = z.object({
  contextId: z.string().optional(),
  contextIds: z.array(z.string()).optional(),
  review: z.object({
    status: z.enum(["pending", "submitted", "cancelled"]),
    action: z.enum(["note", "approve", "resume"]),
    digest: z.string().optional(),
    document: z.string().optional(),
  }).optional(),
  id: z.string(),
  scope: z.string(),
  role: z.enum(["user", "assistant"]),
  body: z.string(),
  at: z.string(),
});
export const researchKindSchema = z.enum(["daily", "background"]);
export type ResearchKind = z.infer<typeof researchKindSchema>;
export const RESEARCH_INTERVAL_MINUTES = {
  daily: 30,
  background: 720,
} as const;
export const researchSettingsSchema = z.object({
  days: z.enum(["china-workdays", "weekdays", "everyday"]).default("china-workdays"),
  start: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).default("10:00"),
  end: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).default("22:00"),
  dailyMinutes: z.number().int().min(5).max(1440).default(30),
  backgroundMinutes: z.number().int().min(30).max(10080).default(720),
}).refine((value) => value.start < value.end, { message: "结束时间须晚于开始时间。" });
export type ResearchSettings = z.infer<typeof researchSettingsSchema>;
const scheduleEntrySchema = z.object({
  blockedReason: z.string().nullable().default(null),
  enabled: z.boolean().default(true),
  nextAt: z.string().datetime().nullable().default(null),
  lastCompletedAt: z.string().datetime().nullable().default(null),
});
const emptySchedule = () => scheduleEntrySchema.parse({});
export const researchSchedulesSchema = z.object({
  settings: researchSettingsSchema.default(() => researchSettingsSchema.parse({})),
  // Legacy shared pause is migrated to the failed research kind on startup.
  blockedReason: z.string().nullable().default(null),
  daily: scheduleEntrySchema.default(emptySchedule),
  background: scheduleEntrySchema.default(emptySchedule),
});
const emptySchedules = () => researchSchedulesSchema.parse({});
const researchViewSchema = researchSchedulesSchema.extend({
  calendarError: z.string().nullable().default(null),
  active: z.preprocess((value) => value == null ? [] : typeof value === "string" ? [value] : value, z.array(researchKindSchema)).default([]),
  queued: z.array(researchKindSchema).default([]),
});
export const runSchema = z.object({
  id: z.string(),
  sessionId: z.string().uuid().optional(),
  taskIds: z.array(z.string()).optional(),
  scope: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  status: z.enum(["running", "succeeded", "failed", "interrupted"]),
  detail: z.string(),
  research: researchKindSchema.optional(),
  source: z.enum(["user", "automatic"]).optional(),
  progress: z.string().optional(),
  lastActivityAt: z.string().nullable().optional(),
  recoveryPath: z.string().nullable().optional(),
});
export const approvalSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  digest: z.string(),
  document: z.string(),
  at: z.string(),
});
export const systemSchema = z.object({
  format: z.literal(3),
  sessions: z.object({ work: z.string().uuid(), background: z.string().uuid() }).default(() => ({ work: crypto.randomUUID(), background: crypto.randomUUID() })),
  onboardingCompletedAt: z.string().datetime().nullable().default(null),
  paused: z.boolean().default(false),
  research: researchSchedulesSchema.default(emptySchedules),
  messages: z.array(messageSchema).default([]),
  runs: z.array(runSchema).default([]),
  approvals: z.array(approvalSchema).default([]),
  acceptances: z.array(approvalSchema).default([]),
  queue: z
    .array(
      z.object({
        kind: z.enum(["user", "event"]).default("user"),
        id: z.string(),
        scope: z.string(),
        message: z.string(),
        research: researchKindSchema.optional(),
        taskIds: z.array(z.string()).optional(),
        reviewIds: z.array(z.string()).optional(),
      }),
    )
    .default([]),
  errors: z.record(z.string(), z.string()).default({}),
  receipts: z.array(z.string()).default([]),
});
export const localProviderSchema = z.enum(["codex", "claude", "trae"]);
export const modelConnectionSchema = z.object({
  provider: localProviderSchema.nullable(),
  label: z.string(),
  status: z.enum(["disconnected", "checking", "connected", "error"]),
  verifiedAt: z.string().nullable(),
  error: z.string().nullable(),
  available: z.array(
    z.object({
      provider: localProviderSchema,
      label: z.string(),
      installed: z.boolean(),
      version: z.string(),
    }),
  ),
});
export const taskViewSchema = z.object({
  id: z.string(),
  title: z.string(),
  project: z.string().nullable().default(null),
  category: taskCategorySchema.nullable().default(null),
  status: z.enum([
    "todo",
    "review",
    "awaiting_ai",
    "queued",
    "done",
    "paused",
  "waiting",
    "archived",
    "running",
    "blocked",
  ]),
  request: requestSchema.nullable(),
  body: z.string(),
  digest: z.string(),
  updatedAt: z.string(),
  files: z.array(z.string()),
  error: z.string().nullable(),
  queued: z.boolean().default(false),
  demo: z.boolean().default(false),
});
export const snapshotSchema = z.object({
  reviewMode: z.literal("batch").optional(),
  onboardingCompletedAt: z.string().datetime().nullable().default(null),
  tasks: z.array(taskViewSchema),
  background: z.object({ body: z.string(), updatedAt: z.string().nullable() }),
  attention: z.string(),
  messages: z.array(messageSchema),
  runs: z.array(runSchema),
  paused: z.boolean(),
  busy: z.boolean(),
  activeScopes: z.array(z.string()).default([]),
  research: researchViewSchema.default(() => researchViewSchema.parse({})),
  runtime: z.object({
    workspace: z.string(),
    modelConnection: modelConnectionSchema,
    fileIssues: z.array(z.object({ file: z.string(), message: z.string() })),
    error: z.string().nullable(),
  }),
});
const requestId = z.string().uuid();
export const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("onboarding_complete"), requestId }),
  z.object({ type: z.literal("research_settings"), requestId, settings: researchSettingsSchema }),
  z.object({ type: z.literal("cancel"), lane: executionLaneSchema.optional() }),
  z.object({ type: z.literal("model_connect"), provider: localProviderSchema }),
  z.object({
    type: z.literal("research"),
    requestId,
    kind: researchKindSchema,
  }),
  z.object({
    type: z.literal("research_schedule"),
    requestId,
    kind: researchKindSchema,
    enabled: z.boolean(),
  }),
  z.object({
    type: z.literal("chat"),
    lane: executionLaneSchema.optional(),
    requestId,
    contextId: z.string().optional(),
    message: z.string().trim().min(1).max(16000),
  }),
  z.object({
    type: z.literal("create"),
    requestId,
    title: z.string().trim().min(1).max(200),
    context: z.string().max(20000),
  }),
  z.object({
    type: z.literal("note"),
    requestId,
    taskId: z.string(),
    message: z.string().trim().min(1).max(16000),
  }),
  z.object({ type: z.literal("review_discard"), requestId, taskId: z.string() }),
  z.object({
    type: z.literal("approve"),
    requestId,
    taskId: z.string(),
    digest: z.string(),
  }),
  z.object({
    type: z.literal("task"),
    requestId,
    taskId: z.string(),
    digest: z.string(),
    action: z.enum(["pause", "resume", "archive"]),
  }),
  z.object({ type: z.literal("pause"), paused: z.boolean() }),
]);
export type CardHeader = z.infer<typeof cardHeaderSchema>;
export type PilotTask = z.infer<typeof taskViewSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Command = z.infer<typeof commandSchema>;
export type SystemState = z.infer<typeof systemSchema>;
export type ModelConnection = z.infer<typeof modelConnectionSchema>;
export const STATUS_LABELS: Record<PilotTask["status"], string> = {
  todo: "待推进",
  review: "待审核",
  awaiting_ai: "待推进",
  queued: "排队中",
  done: "待验收",
  paused: "已暂停",
  waiting: "等待结果",
  archived: "已归档",
  running: "正在推进",
  blocked: "需要处理",
};
export function mapKeys(value: unknown, direction: "camel" | "snake"): unknown {
  if (Array.isArray(value))
    return value.map((item) => mapKeys(item, direction));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        direction === "camel"
          ? key.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase())
          : key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`),
        mapKeys(item, direction),
      ]),
    );
  return value;
}
export const snapshotResponseSchema = z.preprocess(
  (data) => mapKeys(data, "camel"),
  snapshotSchema,
);
export const commandRequestSchema = z.preprocess(
  (data) => mapKeys(data, "camel"),
  commandSchema,
);
