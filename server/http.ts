import type { IncomingMessage, ServerResponse } from "node:http";
import { commandRequestSchema, mapKeys } from "../core";
import { Engine } from "./engine";
import type { LocalModels } from "./local-models";
import { modelFile } from "./workspace-files";
import { filePreview, previewPolicy } from "./file-preview";
export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  engine: Engine,
  origin: string,
  models?: LocalModels,
) {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(JSON.stringify(mapKeys(body, "snake")));
  };
  if (
    req.headers.host !== new URL(origin).host ||
    (req.headers.origin && req.headers.origin !== origin)
  ) {
    send(403, { error: "仅接受本机同源请求。" });
    return;
  }
  try {
    const url = new URL(req.url || "/", origin);
    const path = url.pathname;
    if (req.method === "GET" && path === "/api/pilot/state") {
      send(200, engine.snapshot());
      return;
    }
    if (req.method === "GET" && path.startsWith("/api/pilot/files/")) {
      const name = decodeURIComponent(path.slice("/api/pilot/files/".length));
      if (!modelFile(name)) {
        send(404, { error: "文件不存在。" });
        return;
      }
      const content = engine.store.bytes(name);
      let isText = !content.includes(0);
      try { new TextDecoder("utf-8", { fatal: true }).decode(content); } catch { isText = false; }
      const download = url.searchParams.get("download") === "1";
      const preview = isText && !download && !!req.headers.accept?.split(",").some((type) => type.trim().split(";")[0] === "text/html");
      const body = preview ? filePreview(name, content.toString("utf8")) : content;
      res.writeHead(200, {
        "Content-Type": preview ? "text/html; charset=utf-8" : isText ? "text/plain; charset=utf-8" : "application/octet-stream",
        ...(!isText || download ? { "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name.split("/").at(-1)!)}` } : {}),
        "Cache-Control": "no-store",
        "Vary": "Accept",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": preview ? previewPolicy : "default-src 'none'; sandbox",
      });
      res.end(body);
      return;
    }
    if (req.method === "POST" && path === "/api/pilot/command") {
      if (
        req.headers["x-taskpilot-client"] !== "local" ||
        !req.headers["content-type"]?.startsWith("application/json")
      ) {
        send(403, { error: "缺少本地客户端标识。" });
        return;
      }
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
        if (Buffer.byteLength(body) > 64000) {
          send(413, { error: "请求超过 64 KB。" });
          return;
        }
      }
      const command = commandRequestSchema.parse(JSON.parse(body));
      if (command.type === "model_connect") {
        if (!models) throw new Error("本地模型连接器尚未启动。");
        if (engine.snapshot().busy)
          throw new Error("请等当前运行结束或暂停后再切换模型。");
        await models.connect(command.provider);
      } else engine.command(command);
      send(200, engine.snapshot());
      engine.wake();
      return;
    }
    send(404, { error: "接口不存在。" });
  } catch (error) {
    send(400, { error: error instanceof Error ? error.message : "请求失败。" });
  }
}
