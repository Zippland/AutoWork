// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store";
import { cardFile, digest, encodeCard, parseCard, directoryDigest } from "./documents";
import { validateTurn } from "./file-agent";
import { readModelFiles, validateFiles } from "./workspace-files";
const roots: string[] = [];
const root = () => {
  const value = mkdtempSync(join(tmpdir(), "native-files-"));
  roots.push(value);
  return value;
};
afterEach(() => {
  for (const path of roots.splice(0))
    rmSync(path, { recursive: true, force: true });
});
it("parses arbitrary summary Markdown with only the small interaction header", () => {
  const text = encodeCard(
    {
      title: "摘要",
      status: "review",
      request: { kind: "input", question: "选哪个？" },
      ownField: "自由扩展",
    },
    "### 当前建议\n[细节](notes.md)\n\n无固定区块",
  );
  expect(parseCard(text).header.ownField).toBe("自由扩展");
  expect(parseCard(text).body).toContain("无固定区块");
  expect(() =>
    parseCard(
      encodeCard(
        {
          title: "错配",
          status: "todo",
          request: { kind: "approval", question: "?" },
        },
        "",
      ),
    ),
  ).toThrow();
  expect(() => cardFile("../escape")).toThrow();
});
it("rejects malformed summaries, missing summary, orphan notes, protected writes and path escapes", () => {
  const before = new Map([
    ["background/SUMMARY.md", "总结"],
    [
      cardFile("PIL-1"),
      encodeCard({ title: "项目", status: "todo", request: null }, "摘要"),
    ],
    ["INTERACTIONS.md", "真实记录"],
  ]);
  for (const [name, body] of [
    ["SYSTEM.json", "{}"],
    ["INTERACTIONS.md", "篡改"],
    ["tasks/../escape", "x"],
  ]) {
    const after = new Map(before);
    after.set(name!, body!);
    expect(() =>
      validateTurn(before, after, ["tasks/", "background/"]),
    ).toThrow();
  }
  const removed = new Map(before);
  removed.delete(cardFile("PIL-1"));
  expect(() => validateTurn(before, removed, ["tasks/"])).toThrow("不能删除");
  expect(
    validateFiles(new Map([["tasks/PIL-2/notes.md", "孤立文件"]])).length,
  ).toBeGreaterThan(0);
});
it("keeps the filesystem as source of truth and detects stale transactions", () => {
  const store = new Store(join(root(), "workspace"));
  const before = store.files();
  const after = new Map(before);
  after.set("background/SUMMARY.md", "AI 内容");
  writeFileSync(join(store.directory, "background/SUMMARY.md"), "更新内容");
  expect(() => store.publish(before, after, () => {})).toThrow("较新修改");
  expect(store.raw("background/SUMMARY.md")).toBe("更新内容");
  symlinkSync(
    join(store.directory, "SYSTEM.json"),
    join(store.directory, "background/link"),
  );
  expect(() => readModelFiles(store.directory)).toThrow("符号链接");
});
it("lets models submit delivery for acceptance but never create their own archive transition", () => {
  const name = cardFile("PIL-1");
  const before = new Map([
    ["background/SUMMARY.md", "背景"],
    [name, encodeCard({ title: "交付", status: "todo", request: null }, "进行中")],
  ]);
  const delivered = new Map(before);
  delivered.set(name, encodeCard({ title: "交付", status: "done", request: null }, "待验收成果"));
  delivered.set("tasks/PIL-1/research/SUMMARY.md", "自由笔记，无卡片头");
  expect(validateTurn(before, delivered, ["tasks/"]).get(name)).toContain("待验收成果");
  const archived = new Map(delivered);
  archived.set(name, encodeCard({ title: "交付", status: "archived", request: null }, "声称已验收"));
  expect(() => validateTurn(delivered, archived, ["tasks/"])).toThrow("需要用户验收");
  const newArchive = new Map(before);
  newArchive.set(cardFile("PIL-2"), archived.get(name)!);
  expect(() => validateTurn(before, newArchive, ["tasks/"])).toThrow("需要用户验收");
  expect(() => validateTurn(archived, new Map(archived), ["tasks/"])).not.toThrow();
});
it("recovers a partially committed journal without overwriting a conflicting file", () => {
  const directory = join(root(), "workspace"),
    store = new Store(directory);
  const journal = [
    { file: "background/SUMMARY.md", before: digest(""), content: "第一步" },
    { file: "background/note.md", before: null, content: "第二步" },
  ];
  writeFileSync(join(directory, ".transaction.json"), JSON.stringify(journal));
  writeFileSync(join(directory, "background/SUMMARY.md"), "第一步");
  const recovered = new Store(directory);
  expect(recovered.raw("background/note.md")).toBe("第二步");
  expect(existsSync(join(directory, ".transaction.json"))).toBe(false);
  writeFileSync(
    join(directory, ".transaction.json"),
    JSON.stringify([
      { file: "background/SUMMARY.md", before: digest("old"), content: "bad" },
    ]),
  );
  expect(() => new Store(directory)).toThrow("恢复冲突");
  expect(store.raw("background/SUMMARY.md")).toBe("第一步");
});
it("migrates prior files with originals backed up and no semantic reclassification of the user", () => {
  const data = root(),
    directory = join(data, "workspace");
  mkdirSync(join(directory, "tasks"), { recursive: true });
  mkdirSync(join(directory, "background"));
  writeFileSync(
    join(directory, ".workspace.json"),
    JSON.stringify({ format: 2 }),
  );
  writeFileSync(
    join(directory, "knowledge.json"),
    JSON.stringify({
      profile: { paused: true },
      knowledge: [{ value: "历史" }],
    }),
  );
  writeFileSync(
    join(directory, "frontdesk.json"),
    JSON.stringify({
      frontdesk: {
        messages: [
          {
            id: "m1",
            role: "user",
            body: "原话",
            at: new Date().toISOString(),
          },
        ],
      },
    }),
  );
  writeFileSync(join(directory, "background/SUMMARY.md"), "已有总结");
  const raw =
    "---\n" +
    JSON.stringify({
      task: { key: "PIL-1", title: "既有事项", status: "done" },
      runs: [{ evidence: "历史" }],
    }) +
    "\n---\n\n原有正文\n";
  writeFileSync(join(directory, "tasks/PIL-1.md"), raw);
  const store = new Store(directory);
  expect(store.raw("background/SUMMARY.md")).toBe("已有总结");
  expect(parseCard(store.raw(cardFile("PIL-1"))).body).toContain("原有正文");
  expect(store.raw("tasks/PIL-1/legacy-history.json")).toContain("历史");
  expect(store.system().messages[0]?.body).toBe("原话");
  expect(store.system().paused).toBe(true);
  const backup = readdirSync(join(data, "backups"))[0]!;
  expect(
    readFileSync(
      join(data, "backups", backup, "workspace/tasks/PIL-1.md"),
      "utf8",
    ),
  ).toBe(raw);
  expect(existsSync(join(directory, "knowledge.json"))).toBe(false);
});

it("installs the runtime skill once without replacing the user's own guidance", async () => {
  const { initializeWorkspace } = await import("./initialize");
  const data = root();
  initializeWorkspace(data);
  const path = join(data, ".agents/skills/taskpilot-files/SKILL.md");
  expect(readFileSync(path, "utf8")).toContain("ATTENTION.md");
  writeFileSync(path, "用户维护的 skill");
  initializeWorkspace(data);
  expect(readFileSync(path, "utf8")).toBe("用户维护的 skill");
  expect(readFileSync(join(data, "AGENTS.md"), "utf8")).toContain(
    "taskpilot-files/SKILL.md",
  );
});

it("publishes binary evidence without decoding or corrupting bytes, and detects stale approvals", () => {
  const store = new Store(join(root(), "workspace"));
  const attachment = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff]);
  store.update((_system, files) => {
    files.set(cardFile("PIL-1"), encodeCard({ title: "附件", status: "todo", request: null }, "[原始附件](evidence.png)"));
    files.set("tasks/PIL-1/evidence.png", attachment);
  });
  const before = store.files(), after = new Map(before);
  expect(validateFiles(before)).toEqual([]);
  after.set("tasks/PIL-1/evidence.png", Buffer.from(attachment));
  expect(() => store.publish(before, after, () => {})).not.toThrow();
  expect(store.bytes("tasks/PIL-1/evidence.png")).toEqual(attachment);
  const originalDigest = directoryDigest(before, "tasks/PIL-1/");
  after.set("tasks/PIL-1/evidence.png", Buffer.from([0xff, 0]));
  expect(directoryDigest(after, "tasks/PIL-1/")).not.toBe(originalDigest);
  store.publish(before, after, () => {});
  expect(() => store.publish(before, after, () => {})).toThrow("较新修改");
  expect(new Store(store.directory).bytes("tasks/PIL-1/evidence.png")).toEqual(Buffer.from([0xff, 0]));
});
