import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCard, validTaskId, type FileMap } from "./documents";
export const SUMMARY_FILE = "background/SUMMARY.md";
export function validPath(name: string) {
  return (
    !!name &&
    !name.startsWith("/") &&
    !name.includes("\\") &&
    [...name].every((char) => char.charCodeAt(0) >= 32) &&
    name.split("/").every((part) => part && part !== "." && part !== "..")
  );
}
export const modelFile = (name: string) =>
  validPath(name) &&
  ["background/", "assistant/", "tasks/"].some((prefix) =>
    name.startsWith(prefix),
  );
export const inScope = (name: string, writable: string[]) =>
  writable.some((scope) =>
    scope.endsWith("/") ? name.startsWith(scope) : name === scope,
  );
export function safePath(root: string, name: string) {
  if (!validPath(name)) throw new Error("文件路径无效。");
  let path = root;
  if (lstatSync(root).isSymbolicLink())
    throw new Error("工作区不能是符号链接。");
  for (const part of name.split("/")) {
    path = join(path, part);
    try {
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error("不接受符号链接。");
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
  }
  return path;
}
export function readModelFiles(root: string) {
  const files = new Map<string, string | Buffer>();
  let bytes = 0;
  const walk = (name: string, depth = 0) => {
    if (depth > 20 || files.size > 2000)
      throw new Error("工作目录过大，请先整理文件。");
    const path = safePath(root, name);
    const info = lstatSync(path);
    if (info.isDirectory())
      for (const child of readdirSync(path).sort())
        walk(`${name}/${child}`, depth + 1);
    else {
      if (!info.isFile() || info.size > 64_000_000)
        throw new Error(`${name} 不是 64 MB 以内的普通文件。`);
      bytes += info.size;
      if (bytes > 256_000_000) throw new Error("工作目录超过 256 MB。");
      const content = readFileSync(path);
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
        files.set(name, text.includes("\0") ? content : text);
      } catch {
        files.set(name, content);
      }
    }
  };
  for (const name of ["background", "assistant", "tasks"])
    if (existsSync(join(root, name))) walk(name);
  return files;
}
export function validateFiles(files: FileMap) {
  const issues: { file: string; message: string }[] = [];
  let bytes = 0;
  for (const [name, body] of files) {
    if (
      !modelFile(name) ||
      Buffer.byteLength(body) > 64_000_000
    )
      issues.push({ file: name, message: "路径或文件大小无效。" });
    bytes += Buffer.byteLength(body);
    if ((name === SUMMARY_FILE || name === "assistant/ATTENTION.md" || /^tasks\/[^/]+\/SUMMARY\.md$/.test(name)) && typeof body !== "string")
      issues.push({ file: name, message: "用于看板展示的 Markdown 必须是 UTF-8 文本。附件可以保留原格式。" });
    if (/^tasks\/[^/]+\/SUMMARY\.md$/.test(name)) {
      try {
        if (!validTaskId(name.split("/")[1]!))
          throw new Error("事项编号无效。");
        parseCard(body);
      } catch (error) {
        issues.push({
          file: name,
          message: error instanceof Error ? error.message : "卡片格式无效。",
        });
      }
    }
  }
  if (!files.has(SUMMARY_FILE))
    issues.push({ file: SUMMARY_FILE, message: "缺少背景总结。" });
  for (const name of files.keys())
    if (
      name.startsWith("tasks/") &&
      !files.has(`tasks/${name.split("/")[1]}/SUMMARY.md`)
    )
      issues.push({ file: name, message: "事项目录缺少 SUMMARY.md。" });
  if (files.size > 2000 || bytes > 256_000_000)
    issues.push({ file: "workspace", message: "工作目录超过容量范围。" });
  return issues;
}
