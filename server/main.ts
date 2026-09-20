import { createServer } from "node:http";
import {
  mkdirSync,
  openSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  closeSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, extname, sep } from "node:path";
import { initializeWorkspace } from "./initialize";
import { Store } from "./store";
import { Engine } from "./engine";
import { handleApi } from "./http";
import { discoverLocalModels, LocalModels } from "./local-models";
import { pilotDataDirectory } from "./paths";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const dataDir = pilotDataDirectory();
const port = Number(process.env.TASKPILOT_PORT || 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("TASKPILOT_PORT must be 1024–65535");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const lockFile = resolve(dataDir, "runtime.pid");
try {
  const previous = Number(readFileSync(lockFile, "utf8"));
  if (!Number.isInteger(previous) || previous <= 0)
    throw new Error("Invalid runtime lock; inspect it before restarting.");
  let alive = true;
  try {
    process.kill(previous, 0);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      alive = false;
    else throw error;
  }
  if (alive)
    throw new Error(
      `TaskPilot already owns this data directory (PID ${previous}).`,
    );
  unlinkSync(lockFile);
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
    throw error;
}
const fd = openSync(lockFile, "wx", 0o600);
writeFileSync(fd, String(process.pid));
closeSync(fd);
process.on("exit", () => {
  try {
    if (readFileSync(lockFile, "utf8") === String(process.pid))
      unlinkSync(lockFile);
  } catch {
    /* No lock remains. */
  }
});
initializeWorkspace(dataDir);
const models = new LocalModels(dataDir, await discoverLocalModels());
await models.initialize();
const store = new Store(resolve(dataDir, "workspace"));
const engine = new Engine(
  store,
  () => models.current(),
  () => models.snapshot(),
);
engine.recover();
const origin = `http://127.0.0.1:${port}`;
const vite =
  process.env.NODE_ENV !== "production"
    ? await import("vite").then(({ createServer: createVite }) =>
        createVite({
          root: appRoot,
          server: { middlewareMode: true },
          appType: "spa",
        }),
      )
    : null;
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};
const server = createServer(async (req, res) => {
  if (req.url?.startsWith("/api/")) {
    await handleApi(req, res, engine, origin, models);
    return;
  }
  if (req.headers.host !== new URL(origin).host) {
    res.writeHead(403);
    res.end("Local only");
    return;
  }
  if (vite) {
    vite.middlewares(req, res);
    return;
  }
  try {
    const dist = resolve(appRoot, "dist");
    const path = decodeURIComponent(new URL(req.url || "/", origin).pathname);
    const file = resolve(dist, path === "/" ? "index.html" : `.${path}`);
    if (!file.startsWith(dist + sep)) throw new Error("Invalid path");
    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type": mime[extname(file)] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});
server.once("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => {
  console.log(
    `TaskPilot: ${origin}\nData: ${dataDir}\nAI: ${models.current() ? models.snapshot().label : "not connected (local workflow only)"}`,
  );
  void engine.tick();
});
const timer = setInterval(() => {
  void engine.tick();
}, engine.intervalMs);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    clearInterval(timer);
    engine.stop();
    models.stop();
    server.close();
    void vite?.close();
    setTimeout(() => process.exit(0), 1800);
  });
