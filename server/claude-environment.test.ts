// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeEnvironment } from "./claude-environment";

const roots: string[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), "pilot-claude-env-")); roots.push(root);
  const config = join(root, "config"), cwd = join(root, "project");
  mkdirSync(config); mkdirSync(join(cwd, ".claude"), { recursive: true });
  return { config, cwd, inherited: { CLAUDE_CONFIG_DIR: config, PATH: "/tools", ANTHROPIC_BASE_URL: "https://old.invalid", ANTHROPIC_AUTH_TOKEN: "old-token", ANTHROPIC_API_KEY: "old-key", CLAUDE_CODE_OAUTH_TOKEN: "old-oauth" } };
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

it("uses the saved route and key helper without retaining credentials from an old launcher", async () => {
  const { config, cwd, inherited } = setup();
  writeFileSync(join(config, "settings.json"), JSON.stringify({ apiKeyHelper: "my-existing-helper", env: { ANTHROPIC_BASE_URL: "https://current.invalid", ANTHROPIC_MODEL: "model/current" } }));
  const env = await claudeEnvironment(cwd, inherited);
  expect(env).toMatchObject({ PATH: "/tools", ANTHROPIC_BASE_URL: "https://current.invalid", ANTHROPIC_MODEL: "model/current" });
  expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  expect(inherited.ANTHROPIC_AUTH_TOKEN).toBe("old-token");
});

it("preserves environment-only authentication and explicit project overrides", async () => {
  const { config, cwd, inherited } = setup();
  expect(await claudeEnvironment(cwd, inherited)).toEqual(inherited);
  writeFileSync(join(config, "settings.json"), JSON.stringify({ apiKeyHelper: "helper", env: { ANTHROPIC_BASE_URL: "https://user.invalid" } }));
  writeFileSync(join(cwd, ".claude/settings.local.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://project.invalid", ANTHROPIC_AUTH_TOKEN: "explicit-project-token" } }));
  expect(await claudeEnvironment(cwd, inherited)).toMatchObject({ ANTHROPIC_BASE_URL: "https://project.invalid", ANTHROPIC_AUTH_TOKEN: "explicit-project-token" });
});

it("does not silently fall back to old credentials when native configuration is broken", async () => {
  const { config, cwd, inherited } = setup();
  writeFileSync(join(config, "settings.json"), '{"broken":"DO_NOT_PRINT_SECRET"');
  await expect(claudeEnvironment(cwd, inherited)).rejects.toThrow("不是有效 JSON");
});
