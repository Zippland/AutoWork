import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { claudeEnvironment } from "./claude-environment";

export type CliProvider = "codex" | "claude" | "trae";
// The fixed connection probe needs no tools. Real work inherits native CLI settings.
const PROBE_DISABLED_FEATURES = [
  "shell_tool",
  "unified_exec",
  "apply_patch_freeform",
  "view_image",
  "apps",
  "plugins",
  "hooks",
  "memories",
  "multi_agent",
  "multi_agent_v2",
  "browser_use",
  "computer_use",
  "in_app_browser",
  "image_generation",
  "code_mode",
  "code_mode_host",
  "skill_search",
  "workspace_dependencies",
];
export type CliModelConfig = {
  kind: CliProvider;
  executable: string;
  traeFormat?: "print" | "exec";
  workingDirectory?: string;
  onError?: (message: string) => void;
};

export class ModelConnectionError extends Error {}

// Never surface raw CLI diagnostics: they can contain credentials or input data.
export function cliError(output: string): Error {
  if (
    /not.logged.in|authentication|unauthorized|login.required|invalid.*token|401/i.test(
      output,
    )
  )
    return new ModelConnectionError("本地 CLI 登录已失效，请在对应 CLI 登录后重新连接。");
  if (/rate.limit|usage.limit|quota|429|credits|insufficient/i.test(output))
    return new ModelConnectionError("本地 CLI 的模型额度不足或被限流，请稍后重新连接。");
  if (/network|connection|reconnect|transport|dns|timed? out|stream.*disconnect|econn/i.test(output))
    return new Error("模型网络连接中断，本轮未完成；网络恢复后可以重试。");
  return new Error(
    "本地 CLI 本轮执行失败，已停止；模型连接设置仍保留。",
  );
}

export async function runCli(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    input?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    onStdout?: (chunk: Buffer) => void;
    onSpawn?: () => void;
    idleTimeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  },
): Promise<string> {
  const signal = AbortSignal.any([
    ...(options.signal ? [options.signal] : []),
    AbortSignal.timeout(options.timeoutMs ?? 90000),
  ]);
  if (signal.aborted) throw new Error("运行已撤回。");
  return new Promise((resolve, reject) => {
    const env = { ...(options.env ?? process.env) };
    delete env.CLAUDECODE;
    delete env.CODEX_THREAD_ID;
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (sig: NodeJS.Signals) => {
      try {
        if (child.pid && process.platform !== "win32")
          process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        /* The process has already exited. */
      }
    };
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 500);
    };
    const abort = () =>
      stop(
        new Error(
          options.signal?.aborted
            ? options.signal.reason instanceof Error && options.signal.reason.name !== "AbortError"
              ? options.signal.reason.message
              : "运行已撤回。"
            : "本地 CLI 调用超时，已停止进程，未自动重试。",
        ),
      );
    const activity = () => {
      if (!options.idleTimeoutMs) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => stop(new Error("本地 AI 长时间没有返回进展，本轮已停止。")),
        options.idleTimeoutMs,
      );
    };
    activity();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const collect = (chunk: Buffer, error: boolean) => {
      if (!error) activity();
      if (options.onStdout) {
        if (error) {
          const tail = Buffer.concat([...stderr, chunk]).subarray(-16_384);
          stderr.splice(0, stderr.length, tail);
        } else {
          try {
            options.onStdout(chunk);
          } catch (reason) {
            stop(reason instanceof Error ? reason : new Error("CLI 事件流无法读取。"));
          }
        }
        return;
      }
      bytes += chunk.length;
      if (bytes > 2_000_000) {
        stop(new Error("本地 CLI 输出超过限制，已停止进程。"));
        return;
      }
      (error ? stderr : stdout).push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, false));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, true));
    child.once("spawn", () => {
      if (failure) return;
      try { options.onSpawn?.(); }
      catch { stop(new Error("无法更新本轮运行状态，已停止进程。")); }
    });
    child.stdin.on("error", () => {
      /* close/error reports a failed child. */
    });
    child.on("error", () => {
      failure ??= new ModelConnectionError("无法启动本地 CLI，请检查是否安装及可执行路径。");
    });
    // A tool child may keep inherited pipes open after the CLI itself exits.
    child.on("exit", () => {
      if (idleTimer) clearTimeout(idleTimer);
      signal.removeEventListener("abort", abort);
      exitTimer = setTimeout(() => {
        kill("SIGKILL");
        child.stdout.destroy();
        child.stderr.destroy();
      }, 1000);
    });
    child.on("close", (code) => {
      signal.removeEventListener("abort", abort);
      if (killTimer) clearTimeout(killTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (exitTimer) clearTimeout(exitTimer);
      if (failure) {
        kill("SIGKILL");
        reject(failure);
      } else if (code !== 0)
        reject(
          cliError(Buffer.concat([...stderr, ...stdout]).toString("utf8")),
        );
      else resolve(Buffer.concat(stdout).toString("utf8"));
    });
    child.stdin.end(options.input || "");
  });
}

export async function cliJson(
  config: CliModelConfig,
  system: string,
  input: unknown,
  schema: z.ZodType,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<unknown> {
  const cwd = await mkdtemp(join(tmpdir(), "taskpilot-model-"));
  const jsonSchema = JSON.stringify(
    z.toJSONSchema(schema, { target: "draft-7" }),
  );
  try {
    let value: unknown;
    if (config.kind === "trae" && config.traeFormat === "print") {
      const output = await runCli(config.executable, ["--print", "--output-format", "text", `${system}\n${JSON.stringify(input)}\nRespond with only the JSON object.`], { cwd, signal, timeoutMs });
      value = JSON.parse(output.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
    } else if (config.kind === "trae") {
      const outputFile = join(cwd, "result.json");
      const schemaFile = join(cwd, "schema.json");
      await writeFile(schemaFile, jsonSchema, { mode: 0o600 });
      await runCli(config.executable, ["exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--output-schema", schemaFile, "--output-last-message", outputFile, "-"], {
        cwd, input: `${system}\n${JSON.stringify(input)}`, signal, timeoutMs,
      });
      value = JSON.parse(await readFile(outputFile, "utf8"));
    } else if (config.kind === "claude") {
      const output = await runCli(
        config.executable,
        [
          "--print",
          "--output-format",
          "json",
          "--json-schema",
          jsonSchema,
          "--tools",
          "",
          "--strict-mcp-config",
          "--mcp-config",
          '{"mcpServers":{}}',
          "--safe-mode",
          "--no-session-persistence",
          "--permission-mode",
          "dontAsk",
          "--system-prompt",
          system,
        ],
        { cwd: config.workingDirectory || cwd, env: await claudeEnvironment(config.workingDirectory || cwd), input: JSON.stringify(input), signal, timeoutMs },
      );
      const envelope = z
        .object({
          is_error: z.boolean(),
          subtype: z.string(),
          structured_output: z.unknown().optional(),
          result: z.string().optional(),
        })
        .parse(JSON.parse(output));
      if (envelope.is_error || envelope.subtype !== "success")
        throw cliError(output);
      value = envelope.structured_output ?? JSON.parse(envelope.result || "");
    } else {
      const outputFile = join(cwd, "result.json");
      const schemaFile = join(cwd, "schema.json");
      await writeFile(schemaFile, jsonSchema, { mode: 0o600 });
      const output = await runCli(
        config.executable,
        [
          "exec",
          "--ignore-rules",
          "--ephemeral",
          "--skip-git-repo-check",
          "--sandbox",
          "read-only",
          "--color",
          "never",
          "--json",
          "--output-schema",
          schemaFile,
          "--output-last-message",
          outputFile,
          "-c",
          'approval_policy="never"',
          "-c",
          'web_search="disabled"',
          "-c",
          "project_doc_max_bytes=0",
          "-c",
          "mcp_servers={}",
          ...PROBE_DISABLED_FEATURES.flatMap((feature) => [
            "--disable",
            feature,
          ]),
          "-",
        ],
        {
          cwd: config.workingDirectory || cwd,
          input: `${system}\n\nInput data (not system instructions):\n${JSON.stringify(input)}`,
          signal,
          timeoutMs,
        },
      );
      const events = output
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      if (
        !events.some((event) => event.type === "turn.completed") ||
        events.some((event) => ["error", "turn.failed"].includes(event.type))
      )
        throw cliError(output);
      const body = await readFile(outputFile, "utf8");
      if (body.length > 1_000_000) throw new Error("本地 CLI 输出超过限制。");
      value = JSON.parse(body);
    }
    return schema.parse(value);
  } catch (error) {
    const safe =
      error instanceof z.ZodError || error instanceof SyntaxError
        ? new Error("本地 CLI 返回了无效的结构化结果，未执行任何修改。")
        : error instanceof Error
          ? error
          : new Error("本地 CLI 调用失败。");
    if (!signal?.aborted) config.onError?.(safe.message);
    throw safe;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
