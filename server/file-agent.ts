import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { claudeEnvironment } from "./claude-environment";
import { parseCard, sameContent, type FileMap } from "./documents";
import { cliError, ModelConnectionError, runCli, type CliModelConfig } from "./cli-model";
import {
  inScope,
  modelFile,
  readModelFiles,
  SUMMARY_FILE,
  validateFiles,
} from "./workspace-files";
const skillPath = fileURLToPath(
  new URL("../.agents/skills/taskpilot-files/SKILL.md", import.meta.url),
);
const toolServer = fileURLToPath(new URL("./file-tools.mjs", import.meta.url));
export type FileTurn = (
  config: CliModelConfig,
  files: FileMap,
  writable: string[],
  instruction: string,
  signal: AbortSignal,
  runtime?: { runId: string; onProgress: (stage: string) => void },
) => Promise<FileMap & { reply?: string }>;
export class FileTurnError extends Error {
  constructor(message: string, readonly recoveryPath: string | null) {
    super(message);
  }
}
export const runFileTurn: FileTurn = async (
  config,
  files,
  writable,
  instruction,
  signal,
  runtime,
) => {
  const temporary = await mkdtemp(join(tmpdir(), "taskpilot-files-"));
  const root = join(temporary, "workspace");
  let retainTemporary = false;
  let stage = "正在准备本轮资料";
  const progress = (value: string) => {
    stage = value;
    runtime?.onProgress(value);
  };
  try {
    progress(stage);
    const contents = new Map(files);
    contents.set(
      "SKILL.md",
      await readFile(
        config.workingDirectory
          ? join(
              config.workingDirectory,
              ".agents/skills/taskpilot-files/SKILL.md",
            )
          : skillPath,
        "utf8",
      ),
    );
    for (const [name, content] of contents) {
      await mkdir(dirname(join(root, name)), { recursive: true, mode: 0o700 });
      await writeFile(join(root, name), content, { mode: 0o600 });
    }
    const manifestPath = join(temporary, "scope.json");
    const directories = writable.filter((name) => name.endsWith("/"));
    await writeFile(
      manifestPath,
      JSON.stringify({
        root,
        directories,
        files: Object.fromEntries(
          [...contents.keys()].map((name) => [
            name,
            writable.includes(name) ||
              directories.some((directory) => name.startsWith(directory)),
          ]),
        ),
      }),
      { mode: 0o600 },
    );
    const prompt = `Start by reading AGENTS.md in your working directory and viewing the TaskPilot web board at http://127.0.0.1:${process.env.TASKPILOT_PORT || "4317"}/. Treat the TaskPilot board as read-only during model turns: do not click its chat-send, refresh, resume, pause, approval or acceptance controls. Those controls record human actions and may interrupt your own run; update TaskPilot only through this turn's staged files. Then read SKILL.md with taskpilot_files.read_file and follow the taskpilot-files skill. TaskPilot adds workspace conventions, not a restriction on your native tools, skills, plugins or MCP servers. Use your available capabilities to carry out the task. For TaskPilot records, edit this turn's workspace copy at ${JSON.stringify(root)} using the provided file tools or your native file tools; the host validates and publishes it once you finish. Save useful evidence and progress as you go. Aim for a useful bounded result within about 8 minutes, record unfinished coverage explicitly, and finish the turn instead of endlessly expanding research. If a prior run has recoveryPath in INTERACTIONS.md, inspect its unpublished drafts with native file tools when relevant; reconcile them with current files and verify external outcomes before continuing. Do not write the live workspace directly during this turn, because that would conflict with publication. External actions are not rolled back by file validation: verify their real results and record them accurately; never blindly repeat an action with an uncertain outcome. Reply naturally, not as a JSON action list.\n\n${instruction}`;
    let reply = "";
    if (config.kind === "trae" && config.traeFormat === "print") {
      reply = await runCli(config.executable, ["--print", "--output-format", "text", prompt.replace("Then read SKILL.md with taskpilot_files.read_file", "Then read this turn's SKILL.md with your native file tools") + "\nUse native tools to read and update this turn's staged files. No specific MCP server is required."], { cwd: config.workingDirectory || root, signal, timeoutMs: 15 * 60_000, onSpawn: () => progress("AI 已启动，等待结果") });
    } else if (config.kind === "trae") {
      const replyPath = join(temporary, "reply.md");
      await runCli(config.executable, ["exec", "--ephemeral", "--skip-git-repo-check", "--color", "never", "--json", "--output-last-message", replyPath, "-"], {
        cwd: config.workingDirectory || root,
        input: prompt.replace("Then read SKILL.md with taskpilot_files.read_file", "Then read this turn's SKILL.md with your native file tools") + "\nUse native file tools to manage the staged workspace. TaskPilot does not require a particular MCP server.",
        signal, timeoutMs: 60 * 60_000, idleTimeoutMs: 5 * 60_000,
        onSpawn: () => progress("AI 已启动，等待进展"),
        onStdout: () => progress("本地 AI 正在处理任务"),
      });
      reply = await readFile(replyPath, "utf8");
    } else if (config.kind === "codex") {
      const replyPath = join(temporary, "reply.txt");
      const decoder = new StringDecoder("utf8");
      let pending = "", completed = false, failed = false, failureDetail = "";
      const event = (line: string) => {
        if (!line.trim()) return;
        const value = JSON.parse(line);
        if (value.type === "thread.started") progress("本地 AI 已启动");
        if (value.type === "turn.started") progress("正在理解任务");
        if (value.type === "item.started" || value.type === "item.completed") {
          const type = value.item?.type;
          if (type === "command_execution") progress("正在执行本地工具");
          else if (type === "mcp_tool_call") {
            const tool = String(value.item?.tool || "");
            progress(/write|edit/.test(tool) && value.item?.server === "taskpilot_files"
              ? "正在保存本轮资料"
              : /browser|cua/.test(`${value.item?.server} ${tool}`)
                ? "正在查看网页"
                : "正在使用工具处理任务");
          } else if (type === "agent_message") progress("正在整理回复");
          else if (type === "reasoning") progress("正在分析已获取的信息");
        }
        if (value.type === "turn.completed") {
          completed = true;
          progress("正在保存结果");
        }
        if (["error", "turn.failed"].includes(value.type)) {
          if (value.type === "turn.failed") failed = true;
          failureDetail = line.slice(-16_384);
          if (/network|connection|reconnect|transport|timed? out|stream.*disconnect/i.test(line))
            progress("连接出现波动，正在等待恢复");
        }
      };
      const consume = (text: string) => {
        pending += text;
        let newline: number;
        while ((newline = pending.indexOf("\n")) !== -1) {
          event(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
        }
        if (Buffer.byteLength(pending) > 16_000_000)
          throw new Error("CLI 单条事件超过 16 MB；本轮已停止，模型连接仍保留。");
      };
      await runCli(
        config.executable,
        [
          "exec",
          "--ephemeral",
          "--skip-git-repo-check",
          "--color",
          "never",
          "--json",
          "--output-last-message",
          replyPath,
          "-c",
          `mcp_servers.taskpilot_files.command=${JSON.stringify(process.execPath)}`,
          "-c",
          `mcp_servers.taskpilot_files.args=${JSON.stringify([toolServer, manifestPath])}`,
          "-c",
          'mcp_servers.taskpilot_files.default_tools_approval_mode="approve"',
          "-c",
          "mcp_servers.taskpilot_files.required=true",
          "-",
        ],
        {
          cwd: config.workingDirectory || root,
          input: prompt,
          signal,
          timeoutMs: 60 * 60_000,
          idleTimeoutMs: 5 * 60_000,
          onSpawn: () => progress("AI 已启动，等待进展"),
          onStdout: (chunk) => consume(decoder.write(chunk)),
        },
      );
      consume(decoder.end());
      event(pending);
      if (!completed || failed) throw cliError(failureDetail);
      reply = await readFile(replyPath, "utf8");
    } else {
      const mcp = {
        mcpServers: {
          taskpilot_files: {
            command: process.execPath,
            args: [toolServer, manifestPath],
          },
        },
      };
      const output = await runCli(
        config.executable,
        [
          "--print",
          "--output-format",
          "json",
          "--mcp-config",
          JSON.stringify(mcp),
          "--no-session-persistence",
          "--allowedTools",
          "mcp__taskpilot_files__*",
        ],
        {
          cwd: config.workingDirectory || root,
          input: prompt,
          signal,
          timeoutMs: 15 * 60_000,
          onSpawn: () => progress("AI 已启动，等待结果"),
          env: await claudeEnvironment(config.workingDirectory || root),
        },
      );
      const result = JSON.parse(output);
      if (result.is_error || result.subtype !== "success")
        throw cliError(output);
      reply = typeof result.result === "string" ? result.result : "";
    }
    progress("正在保存结果");
    const result = new Map<string, string | Buffer>();
    for (const name of files.keys())
      if (!directories.some((directory) => name.startsWith(directory)))
        result.set(name, typeof files.get(name) === "string" ? await readFile(join(root, name), "utf8") : await readFile(join(root, name)));
    for (const entry of readModelFiles(root)) result.set(...entry);
    return Object.assign(result, { reply });
  } catch (error) {
    const safe =
      error instanceof SyntaxError
        ? new Error("CLI 返回格式不完整；事项文件未保存。")
        : error instanceof Error
          ? error
          : new Error("文件工作流执行失败。");
    if (!signal.aborted && safe instanceof ModelConnectionError)
      config.onError?.(safe.message);
    let recoveryPath: string | null = null;
    // Preserve the raw staged directory; even malformed or binary files must survive.
    // Rename does not dereference symlinks or require parsing the failed draft.
    try {
      const recovery = runtime && config.workingDirectory
        ? join(config.workingDirectory, "recovery", runtime.runId)
        : temporary;
      await mkdir(recovery, { recursive: true, mode: 0o700 });
      if (recovery !== temporary) await rename(root, join(recovery, "workspace"));
      else retainTemporary = true;
      recoveryPath = recovery;
      await writeFile(join(recovery, "README.md"),
        `# 未发布的运行记录\n\n原因：${safe.message}\n最后进展：${stage}\n\nworkspace/ 保留本轮工作副本（含附件及参考文件），不代表完成或用户验收。结合最新正式文件核对后再使用，不要自动覆盖。外部操作可能已发生，继续前核实结果，避免重复执行。\n`, { mode: 0o600 });
    } catch {
      retainTemporary = true;
      recoveryPath ||= temporary;
    }
    throw new FileTurnError(safe.message, recoveryPath);
  } finally {
    if (!retainTemporary) await rm(temporary, { recursive: true, force: true });
  }
};

export function validateTurn(
  before: FileMap,
  after: FileMap,
  writable: string[],
) {
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    if (sameContent(before.get(name), after.get(name))) continue;
    if (!modelFile(name) || !inScope(name, writable))
      throw new Error(`${name} 超出本轮写入范围。`);
    if (
      !after.has(name) &&
      (name === SUMMARY_FILE || name.endsWith("/SUMMARY.md"))
    )
      throw new Error(`不能删除 ${name}；事项完成后提交用户验收归档。`);
  }
  const files = new Map([...after].filter(([name]) => modelFile(name)));
  const issues = validateFiles(files);
  if (issues.length)
    throw new Error(
      issues.map((issue) => `${issue.file}: ${issue.message}`).join("\n"),
    );
  for (const [name, raw] of files) {
    if (!/^tasks\/[^/]+\/SUMMARY\.md$/.test(name)) continue;
    if (parseCard(raw).header.status !== "archived") continue;
    const original = before.get(name);
    if (!original || parseCard(original).header.status !== "archived")
      throw new Error(`${name} 需要用户验收后才能归档；请设为 done 提交验收。`);
  }
  return files;
}
