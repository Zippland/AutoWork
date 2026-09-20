import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// A long-lived launcher can retain credentials and routing from an old shell.
// Respect explicitly saved Claude settings without modifying the parent process
// or copying secrets into TaskPilot's persisted preferences.
export async function claudeEnvironment(cwd: string, inherited: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  const env = { ...inherited };
  const configured: Record<string, string> = {};
  let helper: unknown;
  const paths = [
    join(inherited.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json"),
    join(cwd, ".claude/settings.json"),
    join(cwd, ".claude/settings.local.json"),
  ];
  for (const path of [...new Set(paths)]) {
    let raw: string;
    try { raw = await readFile(path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error("无法读取 Claude Code 的本地配置，请检查配置文件权限。");
    }
    let settings: { env?: Record<string, unknown>; apiKeyHelper?: unknown };
    try { settings = JSON.parse(raw); }
    catch { throw new Error("Claude Code 的本地配置不是有效 JSON，请先修复配置文件。"); }
    if (!settings || typeof settings !== "object") throw new Error("Claude Code 的本地配置格式无效。");
    for (const [key, value] of Object.entries(settings.env || {})) {
      if (typeof value === "string") configured[key] = value;
    }
    if (Object.hasOwn(settings, "apiKeyHelper")) helper = settings.apiKeyHelper;
  }
  Object.assign(env, configured);
  if (typeof helper === "string" && helper.trim()) {
    for (const key of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) {
      if (!Object.hasOwn(configured, key)) delete env[key];
    }
  }
  return env;
}
