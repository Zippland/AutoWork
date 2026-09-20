// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { snapshotResponseSchema } from "../core";
import { Store } from "./store";
import { Engine } from "./engine";
import { handleApi } from "./http";
const roots: string[] = [],
  servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "native-http-"));
  roots.push(root);
  const engine = new Engine(new Store(join(root, "workspace")));
  let origin = "";
  const server = createServer((req, res) => {
    void handleApi(req, res, engine, origin);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing address");
  origin = `http://127.0.0.1:${address.port}`;
  return { origin, engine };
}
it("serves validated snapshots and accepts idempotent create/read interactions", async () => {
  const { origin } = await fixture();
  const requestId = randomUUID();
  const send = () =>
    fetch(`${origin}/api/pilot/command`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-TaskPilot-Client": "local",
      },
      body: JSON.stringify({
        type: "create",
        request_id: requestId,
        title: "本地事项",
        context: "上下文",
      }),
    });
  expect((await send()).status).toBe(200);
  await send();
  const state = snapshotResponseSchema.parse(
    await (await fetch(`${origin}/api/pilot/state`)).json(),
  );
  expect(state.tasks).toHaveLength(1);
  const file = await fetch(`${origin}/api/pilot/files/tasks/PIL-1/SUMMARY.md`);
  expect(await file.text()).toContain("上下文");
  expect(file.headers.get("content-security-policy")).toContain("sandbox");
});
it("rejects malformed commands, foreign origin, missing header and protected file access", async () => {
  const { origin } = await fixture();
  expect(
    (
      await fetch(`${origin}/api/pilot/state`, {
        headers: { Origin: "https://foreign.example" },
      })
    ).status,
  ).toBe(403);
  expect(
    (await fetch(`${origin}/api/pilot/command`, { method: "POST", body: "{}" }))
      .status,
  ).toBe(403);
  expect(
    (
      await fetch(`${origin}/api/pilot/command`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-TaskPilot-Client": "local",
        },
        body: JSON.stringify({ type: "approve" }),
      })
    ).status,
  ).toBe(400);
  expect((await fetch(`${origin}/api/pilot/files/SYSTEM.json`)).status).toBe(
    404,
  );
  expect((await fetch(`${origin}/api/pilot/materials`)).status).toBe(404);
});

it("downloads original binary evidence without treating it as UTF-8 or executable HTML", async () => {
  const { origin, engine } = await fixture();
  const bytes = Buffer.from([0x89, 0, 0xff, 0x81]);
  engine.store.update((_system, files) => files.set("background/原始附件.png", bytes));
  const response = await fetch(`${origin}/api/pilot/files/${encodeURIComponent("background/原始附件.png")}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/octet-stream");
  expect(response.headers.get("content-disposition")).toContain("attachment");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
});

it("opens Chinese Markdown attachments as readable pages while preserving raw API reads and downloads", async () => {
  const { origin, engine } = await fixture();
  const name = "background/说明稿.md";
  const body = "# 说明稿\n\n| 项目 | 进展 |\n| --- | ---: |\n| 演示 | **已就绪** |\n\n[详细记录](资料/记录.md)\n\n<script>alert('no')</script>\n";
  engine.store.update((_system, files) => files.set(name, body));
  const path = `/api/pilot/files/${name.split("/").map(encodeURIComponent).join("/")}`;
  const response = await fetch(origin + path, { headers: { Accept: "text/html,application/xhtml+xml" } });
  const html = await response.text();
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(response.headers.get("vary")).toBe("Accept");
  expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(response.headers.get("content-security-policy")).not.toContain("allow-scripts");
  expect(html).toContain("<title>说明稿.md · TaskPilot</title>");
  expect(html).toContain("<h1>说明稿</h1>");
  expect(html).toContain("<table>");
  expect(html).toContain("<strong>已就绪</strong>");
  expect(html).toContain('href="/api/pilot/files/background/%E8%B5%84%E6%96%99/%E8%AE%B0%E5%BD%95.md"');
  expect(html).toContain('target="_self"');
  expect(html).toContain(`href="${path}?download=1"`);
  expect(html).not.toContain("<script>");
  expect(await (await fetch(origin + path)).text()).toBe(body);
  const download = await fetch(origin + path + "?download=1", { headers: { Accept: "text/html" } });
  expect(download.headers.get("content-disposition")).toContain("attachment; filename*=UTF-8''%E8%AF%B4%E6%98%8E%E7%A8%BF.md");
  expect(await download.text()).toBe(body);
});

it("shows text attachments as escaped text, never as active HTML", async () => {
  const { origin, engine } = await fixture();
  const body = '<script>alert("no")</script><h1>原始 HTML</h1>';
  engine.store.update((_system, files) => files.set("background/evidence.html", body));
  const response = await fetch(`${origin}/api/pilot/files/background/evidence.html`, { headers: { Accept: "text/html" } });
  const html = await response.text();
  expect(html).toContain('<pre class="file-text">&lt;script&gt;');
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<h1>");
});
