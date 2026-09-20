// Explicit opt-in must precede executable discovery or account access.
if (process.env.TASKPILOT_RUN_REAL_AGENT_SMOKE !== "1")
  throw new Error(
    "Set TASKPILOT_RUN_REAL_AGENT_SMOKE=1 only after explicit user authorization.",
  );
const { discoverLocalModels } = await import("./local-models");
const { runFileTurn, validateTurn } = await import("./file-agent");
const provider = process.argv[2];
if (provider !== "codex" && provider !== "claude")
  throw new Error("Choose codex or claude.");
const candidate = (await discoverLocalModels()).find(
  (item) => item.provider === provider,
);
if (!candidate?.executable) throw new Error("CLI not installed.");
const before = new Map([
  ["background/SUMMARY.md", ""],
  [
    "INTERACTIONS.md",
    "Controlled smoke only: write a short fictional background summary; no external actions.",
  ],
]);
const after = await runFileTurn(
  { kind: provider, executable: candidate.executable },
  before,
  ["background/"],
  "FRONTDESK: write a fictional summary in background/SUMMARY.md, then reply naturally.",
  new AbortController().signal,
);
validateTurn(before, after, ["background/"]);
if (!after.get("background/SUMMARY.md")?.toString().trim() || !after.reply?.trim())
  throw new Error("Missing summary or reply.");
console.log("Isolated file-native smoke passed.");
export {};
