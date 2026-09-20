import { createHash } from "node:crypto";
import { cardHeaderSchema, type CardHeader } from "../core";
export type FileContent = string | Buffer;
export type FileMap = Map<string, FileContent>;
export const textContent = (content: FileContent): string =>
  typeof content === "string" ? content : new TextDecoder("utf-8", { fatal: true }).decode(content);
export const sameContent = (left: FileContent | undefined, right: FileContent | undefined) =>
  left === right || (left !== undefined && right !== undefined && digest(left) === digest(right));
export const digest = (text: FileContent) =>
  createHash("sha256").update(text).digest("hex");
export const validTaskId = (id: string) =>
  !["frontdesk", "background"].includes(id) &&
  /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id);
export const cardFile = (id: string) => {
  if (!validTaskId(id)) throw new Error("事项编号无效。");
  return `tasks/${id}/SUMMARY.md`;
};
export function parseCard(content: FileContent) {
  const raw = textContent(content);
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (!header)
    throw new Error("SUMMARY.md 需要 JSON 文件头（title、status、request）。");
  const metadata = cardHeaderSchema.parse(JSON.parse(header[1]!));
  if (metadata.status === "review" && !metadata.request)
    throw new Error("待审核事项需要具体的问题或审批内容。");
  if (metadata.status !== "review" && metadata.request)
    throw new Error("有待用户回应的问题时，请使用 review 状态。");
  return {
    header: metadata,
    body: raw.slice(header[0].length).replace(/^\n/, ""),
  };
}
export function encodeCard(header: CardHeader, body: string) {
  return `---\n${JSON.stringify(header, null, 2)}\n---\n\n${body}`;
}
export const directoryDigest = (files: FileMap, prefix: string) =>
  digest(
    JSON.stringify(
      [...files]
        .filter(([name]) => name.startsWith(prefix))
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
