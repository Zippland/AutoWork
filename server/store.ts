import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { systemSchema, type SystemState } from "../core";
import { digest, sameContent, type FileMap } from "./documents";
import {
  SUMMARY_FILE,
  modelFile,
  readModelFiles,
  safePath,
  validateFiles,
} from "./workspace-files";
import { migrateWorkspace } from "./migrate-files";
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const transactionSchema = z.array(
  z.object({
    file: z.string(),
    before: z.string().nullable(),
    content: z.string().nullable(),
    encoding: z.enum(["utf8", "base64"]).default("utf8"),
  }),
);
export class Store {
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink())
      throw new Error("工作区不能是符号链接。");
    migrateWorkspace(directory);
    this.recover();
    if (!existsSync(join(directory, "SYSTEM.json"))) {
      if (readdirSync(directory).length)
        throw new Error("已有文件但缺少 SYSTEM.json；原件未覆盖。");
      this.commit(
        new Map(),
        new Map([
          ["SYSTEM.json", json(systemSchema.parse({ format: 3 }))],
          [SUMMARY_FILE, ""],
        ]),
      );
    }
  }
  files() {
    return readModelFiles(this.directory);
  }
  system() {
    return systemSchema.parse(JSON.parse(this.raw("SYSTEM.json")));
  }
  bytes(name: string) {
    const path = safePath(this.directory, name);
    if (!lstatSync(path).isFile()) throw new Error("仅接受普通文件。");
    return readFileSync(path);
  }
  raw(name: string) {
    const path = safePath(this.directory, name);
    if (!lstatSync(path).isFile()) throw new Error("仅接受普通文件。");
    return readFileSync(path, "utf8");
  }
  updateSystem(change: (state: SystemState) => void) {
    const raw = this.raw("SYSTEM.json"),
      state = systemSchema.parse(JSON.parse(raw));
    change(state);
    this.commit(
      new Map([["SYSTEM.json", raw]]),
      new Map([["SYSTEM.json", json(systemSchema.parse(state))]]),
    );
  }
  update(change: (state: SystemState, files: FileMap) => void) {
    const before = this.files();
    before.set("SYSTEM.json", this.raw("SYSTEM.json"));
    const files = new Map(before);
    files.delete("SYSTEM.json");
    const system = systemSchema.parse(JSON.parse(this.raw("SYSTEM.json")));
    change(system, files);
    systemSchema.parse(system);
    const issues = validateFiles(files);
    if (issues.length)
      throw new Error(
        issues.map((issue) => `${issue.file}: ${issue.message}`).join("\n"),
      );
    files.set("SYSTEM.json", json(system));
    this.commit(before, files);
  }
  publish(
    before: FileMap,
    after: FileMap,
    change: (state: SystemState) => void,
  ) {
    this.update((state, current) => {
      for (const name of new Set([...before.keys(), ...after.keys()])) {
        if (!sameContent(current.get(name), before.get(name)))
          throw new Error(`${name} 已有较新修改，未覆盖。`);
        if (after.has(name)) current.set(name, after.get(name)!);
        else current.delete(name);
      }
      change(state);
    });
  }
  private commit(before: FileMap, after: FileMap) {
    const changes = [...new Set([...before.keys(), ...after.keys()])]
      .filter((name) => !sameContent(before.get(name), after.get(name)))
      .map((file) => ({
        file,
        before: before.has(file) ? digest(before.get(file)!) : null,
        content: after.get(file) instanceof Buffer ? (after.get(file) as Buffer).toString("base64") : after.get(file) ?? null,
        encoding: after.get(file) instanceof Buffer ? "base64" : "utf8",
      }));
    if (!changes.length) return;
    for (const entry of changes) {
      const path = safePath(this.directory, entry.file);
      const current = existsSync(path) ? digest(this.bytes(entry.file)) : null;
      if (current !== entry.before)
        throw new Error(`${entry.file} 保存冲突，原件未覆盖。`);
    }
    writeFileSync(join(this.directory, ".transaction.json"), json(changes), {
      mode: 0o600,
      flag: "wx",
    });
    this.recover();
  }
  private recover() {
    const journal = join(this.directory, ".transaction.json");
    if (!existsSync(journal)) return;
    if (!lstatSync(journal).isFile())
      throw new Error("保存日志必须是普通文件。");
    const changes = transactionSchema.parse(
      JSON.parse(readFileSync(journal, "utf8")),
    );
    for (const entry of changes) {
      if (entry.file !== "SYSTEM.json" && !modelFile(entry.file))
        throw new Error("非法保存路径。");
      const path = safePath(this.directory, entry.file);
      const current = existsSync(path) ? digest(this.bytes(entry.file)) : null;
      if (
        current !== entry.before &&
        current !== (entry.content === null ? null : digest(entry.encoding === "base64" ? Buffer.from(entry.content, "base64") : entry.content))
      )
        throw new Error(`${entry.file} 恢复冲突，原件未覆盖。`);
    }
    for (const entry of changes) {
      const path = safePath(this.directory, entry.file);
      if (entry.content === null) {
        if (existsSync(path)) unlinkSync(path);
        continue;
      }
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      writeFileSync(temporary, entry.encoding === "base64" ? Buffer.from(entry.content, "base64") : entry.content, { mode: 0o600, flag: "wx" });
      renameSync(temporary, path);
      if (digest(this.bytes(entry.file)) !== digest(entry.encoding === "base64" ? Buffer.from(entry.content, "base64") : entry.content))
        throw new Error("文件回读不一致。");
    }
    unlinkSync(journal);
  }
}
