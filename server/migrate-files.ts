import { readModelFiles, validateFiles } from "./workspace-files";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { systemSchema, type CardHeader } from "../core";
import { encodeCard } from "./documents";

export function migrateWorkspace(directory: string) {
  if (!existsSync(join(directory, ".workspace.json"))) return;
  if (existsSync(join(directory, ".transaction.json")))
    throw new Error("旧版本保存尚未完成，请先恢复后再迁移。");
  if (existsSync(join(directory, "SYSTEM.json")))
    throw new Error("新旧工作区格式同时存在，请检查后再启动。");
  const knowledge = JSON.parse(
    readFileSync(join(directory, "knowledge.json"), "utf8"),
  );
  const front = JSON.parse(
    readFileSync(join(directory, "frontdesk.json"), "utf8"),
  );
  const stage = `${directory}-native-${randomUUID()}`;
  const backup = join(
    dirname(directory),
    "backups",
    `before-model-native-${Date.now()}`,
  );
  mkdirSync(stage, { mode: 0o700 });
  try {
    for (const name of ["background", "assistant"]) {
      if (existsSync(join(directory, name)))
        cpSync(join(directory, name), join(stage, name), {
          recursive: true,
          dereference: false,
        });
      else mkdirSync(join(stage, name), { mode: 0o700 });
    }
    if (!existsSync(join(stage, "background/SUMMARY.md")))
      writeFileSync(
        join(stage, "background/SUMMARY.md"),
        knowledge.background?.body || "",
        { mode: 0o600 },
      );
    writeFileSync(
      join(stage, "background/legacy-context.json"),
      JSON.stringify(knowledge, null, 2),
      { mode: 0o600 },
    );
    writeFileSync(
      join(stage, "assistant/legacy-history.json"),
      JSON.stringify(front, null, 2),
      { mode: 0o600 },
    );
    mkdirSync(join(stage, "tasks"), { mode: 0o700 });
    for (const name of readdirSync(join(directory, "tasks")).filter((name) =>
      name.endsWith(".md"),
    )) {
      const raw = readFileSync(join(directory, "tasks", name), "utf8");
      const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(raw);
      if (!match) throw new Error(`旧事项 ${name} 格式异常，未迁移。`);
      const legacy = JSON.parse(match[1]!);
      const task = legacy.task;
      if (!/^PIL-[1-9]\d*$/.test(task.key)) throw new Error("旧事项编号异常。");
      const status: CardHeader["status"] =
        task.status === "done"
          ? "done"
          : task.status === "excluded"
            ? "archived"
            : ["review", "verify", "blocked"].includes(task.status)
              ? "review"
              : "paused";
      const request: CardHeader["request"] =
        status === "review"
          ? {
              kind: task.decision?.kind === "approval" ? "approval" : "input",
              question:
                task.decision?.question ||
                "请查看已有内容，补充下一步要求后继续。",
            }
          : null;
      const target = join(stage, "tasks", task.key);
      mkdirSync(target, { mode: 0o700 });
      writeFileSync(
        join(target, "SUMMARY.md"),
        encodeCard(
          {
            title: task.title,
            status,
            request,
            ...(task.isDemo ? { demo: true } : {}),
          },
          raw
            .slice(match[0].length)
            .replace(/^<!-- taskpilot:\w+ -->\r?\n/gm, ""),
        ),
        { mode: 0o600 },
      );
      writeFileSync(
        join(target, "legacy-history.json"),
        JSON.stringify(legacy, null, 2),
        { mode: 0o600 },
      );
    }
    const research = join(dirname(directory), "research");
    if (existsSync(research))
      cpSync(research, join(stage, "assistant/sources"), { recursive: true });
    const system = systemSchema.parse({
      format: 3,
      paused: !!knowledge.profile?.paused,
      messages: (front.frontdesk?.messages || []).map(
        (message: Record<string, unknown>) => ({
          ...message,
          scope: "frontdesk",
        }),
      ),
    });
    writeFileSync(join(stage, "SYSTEM.json"), JSON.stringify(system, null, 2), {
      mode: 0o600,
    });
    const issues = validateFiles(readModelFiles(stage));
    if (issues.length)
      throw new Error(
        issues.map((issue) => `${issue.file}: ${issue.message}`).join("\n"),
      );
    mkdirSync(backup, { recursive: true, mode: 0o700 });
    renameSync(directory, join(backup, "workspace"));
    try {
      renameSync(stage, directory);
    } catch (error) {
      renameSync(join(backup, "workspace"), directory);
      throw error;
    }
    if (existsSync(research)) renameSync(research, join(backup, "research"));
    console.log(`File-native workspace migrated; backup: ${backup}`);
  } catch (error) {
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}
