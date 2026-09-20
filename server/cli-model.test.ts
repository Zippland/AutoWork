// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { cliJson, runCli, type CliModelConfig } from "./cli-model";
import { LocalModels } from "./local-models";
import { FileTurnError, runFileTurn } from "./file-agent";
import { initializeWorkspace } from "./initialize";

const directories: string[] = [];
function directory() {
  const value = mkdtempSync(join(tmpdir(), "pilot-fake-cli-"));
  directories.push(value);
  return value;
}
function fake(source: string) {
  const root = directory();
  const executable = join(root, "fake agent.cjs");
  writeFileSync(executable, `#!${process.execPath}\n${source}`);
  chmodSync(executable, 0o700);
  return { root, executable };
}
afterEach(() => {
  vi.unstubAllEnvs();
  directories
    .splice(0)
    .forEach((value) => rmSync(value, { recursive: true, force: true }));
});

describe("local CLI boundary", () => {
  it.each(["codex", "claude"] as const)(
    "inherits native %s capabilities while adding the TaskPilot file server",
    async (kind) => {
      const record = join(directory(), "file-turn.json");
      const { executable } = fake(`
      const fs = require('node:fs'); const args = process.argv.slice(2);
      let input = ''; process.stdin.on('data', c => input += c);
      process.stdin.on('end', () => {
        fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({args, input, cwd: process.cwd()}));
        fs.writeFileSync('frontdesk.json', 'edited through controlled CLI');
        if (args.includes('--output-last-message')) fs.writeFileSync(args[args.indexOf('--output-last-message')+1], '自然语言回复');
        console.log(JSON.stringify(${kind === "codex" ? "{type:'turn.completed'}" : "{is_error:false,subtype:'success',result:'自然语言回复'}"}));
      });
    `);
      const before = new Map([
        ["frontdesk.json", "before"],
        ["knowledge.json", "readonly"],
      ]);
      const after = await runFileTurn(
        { kind, executable },
        before,
        ["frontdesk.json"],
        "Controlled instruction",
        new AbortController().signal,
      );
      expect(after.get("frontdesk.json")).toBe("edited through controlled CLI");
      expect(after.reply).toBe("自然语言回复");
      expect(before.get("frontdesk.json")).toBe("before");
      const captured = JSON.parse(readFileSync(record, "utf8"));
      expect(captured.input).toContain("Start by reading AGENTS.md");
      expect(captured.input).toContain("viewing the TaskPilot web board");
      expect(captured.input).toContain(
        "your native tools, skills, plugins or MCP servers",
      );
      expect(captured.input).toContain("External actions are not rolled back");
      expect(() =>
        readFileSync(join(captured.cwd, "frontdesk.json")),
      ).toThrow();
      if (kind === "codex") {
        expect(captured.args).toEqual(
          expect.arrayContaining([
            'mcp_servers.taskpilot_files.default_tools_approval_mode="approve"',
            "mcp_servers.taskpilot_files.required=true",
          ]),
        );
        for (const override of [
          "--ignore-user-config",
          "--ignore-rules",
          "--disable",
          "--sandbox",
          "mcp_servers={}",
          'approval_policy="never"',
          'web_search="disabled"',
          "project_doc_max_bytes=0",
        ])
          expect(captured.args).not.toContain(override);
        expect(captured.args).not.toContain(
          "--dangerously-bypass-approvals-and-sandbox",
        );
      } else {
        for (const override of [
          "--tools",
          "--strict-mcp-config",
          "--setting-sources",
          "--settings",
          "--permission-mode",
          "--safe-mode",
          "--dangerously-skip-permissions",
        ])
          expect(captured.args).not.toContain(override);
        expect(captured.args).toContain("mcp__taskpilot_files__*");
        expect(
          Object.keys(
            JSON.parse(captured.args[captured.args.indexOf("--mcp-config") + 1])
              .mcpServers,
          ),
        ).toEqual(["taskpilot_files"]);
      }
    },
  );
  it("passes stdin without shell expansion and constrains Codex tools, config and schema", async () => {
    const record = join(directory(), "record.json");
    const { executable } = fake(`
      const fs = require('node:fs'); const args = process.argv.slice(2);
      let input = ''; process.stdin.on('data', c => input += c);
      process.stdin.on('end', () => {
        fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({args, input, cwd: process.cwd(), schema: JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1], 'utf8'))}));
        fs.writeFileSync(args[args.indexOf('--output-last-message')+1], JSON.stringify({ok:true}));
        console.log(JSON.stringify({type:'turn.completed'}));
      });
    `);
    const input = { message: "$(touch forbidden); `echo secret`" };
    expect(
      await cliJson(
        { kind: "codex", executable },
        "test",
        input,
        z.object({ ok: z.boolean() }),
      ),
    ).toEqual({ ok: true });
    const recorded = JSON.parse(readFileSync(record, "utf8"));
    expect(recorded.input).toContain(JSON.stringify(input));
    expect(recorded.args).toEqual(
      expect.arrayContaining([
        "--ignore-rules",
        "--ephemeral",
        "read-only",
        "shell_tool",
        "plugins",
        "multi_agent",
        "mcp_servers={}",
      ]),
    );
    expect(recorded.schema.additionalProperties).toBe(false);
    expect(recorded.schema.$schema).toContain("draft-07");
    expect(() => readFileSync(join(recorded.cwd, "result.json"))).toThrow();
  });
  it("uses Claude structured output with tools and customizations disabled", async () => {
    const { executable } = fake(`
      const args=process.argv.slice(2);
      if(args[args.indexOf('--tools')+1] !== '' || !args.includes('--safe-mode') || !args.includes('--strict-mcp-config')) process.exit(9);
      console.log(JSON.stringify({is_error:false, subtype:'success', structured_output:{ok:true}}));
    `);
    expect(
      await cliJson(
        { kind: "claude", executable },
        "test",
        {},
        z.object({ ok: z.boolean() }),
      ),
    ).toEqual({ ok: true });
  });
  it("rejects malformed results and sanitizes authentication errors", async () => {
    const bad = fake(
      `console.log(JSON.stringify({is_error:false,subtype:'success',structured_output:{ok:'wrong'}}));`,
    );
    await expect(
      cliJson(
        { kind: "claude", executable: bad.executable },
        "test",
        {},
        z.object({ ok: z.boolean() }),
      ),
    ).rejects.toThrow("无效的结构化结果");
    const auth = fake(
      `console.error('401 unauthorized SECRET_CREDENTIAL'); process.exit(1);`,
    );
    await expect(
      runCli(auth.executable, [], { cwd: auth.root }),
    ).rejects.toThrow(/^本地 CLI 登录已失效/);
  });
  it("stops timed-out and cancelled children without waiting for a result", async () => {
    const { root, executable } = fake(`setInterval(() => {}, 1000);`);
    await expect(
      runCli(executable, [], { cwd: root, timeoutMs: 150 }),
    ).rejects.toThrow("超时");
    const controller = new AbortController();
    const running = runCli(executable, [], {
      cwd: root,
      signal: controller.signal,
    });
    controller.abort();
    await expect(running).rejects.toThrow("撤回");
  });
  it("caps output and handles a missing executable without resolving a user CLI", async () => {
    const { root, executable } = fake(
      `process.stdout.write('x'.repeat(2100000)); setInterval(()=>{}, 1000);`,
    );
    await expect(runCli(executable, [], { cwd: root })).rejects.toThrow(
      "输出超过限制",
    );
    await expect(
      runCli(join(root, "missing"), [], { cwd: root }),
    ).rejects.toThrow("无法启动");
  });
  it("times out silence while allowing active output, with an absolute deadline", async () => {
    const active = fake(`const timer=setInterval(()=>console.log('progress'),100);setTimeout(()=>clearInterval(timer),1600);`);
    expect(await runCli(active.executable, [], { cwd: active.root, idleTimeoutMs: 1000, timeoutMs: 5000 })).toContain("progress");
    const silent = fake(`setInterval(()=>{},1000);`);
    await expect(runCli(silent.executable, [], { cwd: silent.root, idleTimeoutMs: 100, timeoutMs: 1000 })).rejects.toThrow("没有返回进展");
    const endless = fake(`setInterval(()=>console.log('progress'),20);`);
    await expect(runCli(endless.executable, [], { cwd: endless.root, idleTimeoutMs: 3000, timeoutMs: 1200 })).rejects.toThrow("超时");
  });
  it("finishes when the CLI exits even if a tool child keeps its pipes open", async () => {
    const cli = fake(`require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}).unref();console.log('finished');`);
    expect(await runCli(cli.executable, [], { cwd: cli.root, timeoutMs: 3000 })).toContain("finished");
  });
  it("accepts a completed turn after a transient reconnect and reports progress", async () => {
    const cli = fake(`const fs=require('node:fs');const args=process.argv.slice(2);process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'error',message:'Reconnecting 1/5: stream disconnected'}));fs.writeFileSync(args[args.indexOf('--output-last-message')+1],'已恢复');console.log(JSON.stringify({type:'turn.completed'}));});`);
    const onError = vi.fn(), onProgress = vi.fn();
    const result = await runFileTurn({ kind: "codex", executable: cli.executable, onError }, new Map(), [], "test", new AbortController().signal, {runId: "test", onProgress});
    expect(result.reply).toBe("已恢复");
    expect(onProgress).toHaveBeenCalledWith("连接出现波动，正在等待恢复");
    expect(onError).not.toHaveBeenCalled();
  });
  it("retains unpublished drafts on network failure without changing connection or live files", async () => {
    const cli = fake(`const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2);process.stdin.resume();process.stdin.on('end',()=>{const tools=JSON.parse(args.find(a=>a.startsWith('mcp_servers.taskpilot_files.args=')).split('=').slice(1).join('='));const manifest=JSON.parse(fs.readFileSync(tools[1],'utf8'));fs.writeFileSync(path.join(manifest.root,'background/SUMMARY.md'),'已读取的部分资料');fs.writeFileSync(path.join(manifest.root,'background/raw.bin'),Buffer.from([0xff,0x80,0]));console.log(JSON.stringify({type:'turn.failed',error:{message:'network connection lost'}}));});`);
    initializeWorkspace(cli.root);
    const before = new Map([["background/SUMMARY.md", "正式资料"]]);
    const onError = vi.fn();
    let failure: unknown;
    try {
      await runFileTurn({kind:"codex",executable:cli.executable,workingDirectory:cli.root,onError},before,["background/"],"test",new AbortController().signal,{runId:"controlled-failure",onProgress:()=>{}});
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(FileTurnError);
    const saved = failure as FileTurnError;
    expect(saved.message).toContain("网络连接中断");
    expect(readFileSync(join(saved.recoveryPath!,"workspace/background/SUMMARY.md"),"utf8")).toBe("已读取的部分资料");
    expect(readFileSync(join(saved.recoveryPath!,"README.md"),"utf8")).toContain("不代表完成");
    expect(readFileSync(join(saved.recoveryPath!,"workspace/background/raw.bin"))).toEqual(Buffer.from([0xff,0x80,0]));
    expect(before.get("background/SUMMARY.md")).toBe("正式资料");
    expect(onError).not.toHaveBeenCalled();
  });
  it("preserves Chinese characters across output chunk boundaries", async () => {
    const { root, executable } = fake(
      `const b=Buffer.from('中文响应'); process.stdout.write(b.subarray(0,1)); setTimeout(()=>process.stdout.write(b.subarray(1)),30);`,
    );
    expect(await runCli(executable, [], { cwd: root })).toBe("中文响应");
  });
  it("streams large Codex research logs without losing completion or retaining all tool output", async () => {
    const { executable } = fake(`
      const fs=require('node:fs');const args=process.argv.slice(2);
      process.stdin.resume();process.stdin.on('end',()=>{
        fs.writeFileSync(args[args.indexOf('--output-last-message')+1], '调研完成');
        const line=JSON.stringify({type:'item.completed',item:{text:'浏览器内容'.repeat(1200)}})+'\\n';
        for(let i=0;i<300;i++)process.stdout.write(line);
        process.stderr.write('diagnostic'.repeat(240000));
        process.stdout.write(JSON.stringify({type:'turn.completed'}));
      });
    `);
    const onError = vi.fn();
    const result = await runFileTurn({kind:'codex',executable,onError}, new Map(), [], '大段调研日志', new AbortController().signal);
    expect(result.reply).toBe('调研完成');
    expect(onError).not.toHaveBeenCalled();
  });
  it.each([
    ['{bad json}', false],
    [JSON.stringify({type:'turn.failed',error:{message:'tool failed'}}), false],
    [JSON.stringify({type:'error',message:'401 unauthorized'}), true],
  ])("distinguishes failed work from an invalid model connection: %s", async (output, disconnect) => {
    const { executable } = fake(`console.log(${JSON.stringify(output)});`);
    const onError = vi.fn();
    await expect(runFileTurn({kind:'codex',executable,onError}, new Map(), [], 'test', new AbortController().signal)).rejects.toThrow();
    expect(onError).toHaveBeenCalledTimes(disconnect ? 1 : 0);
  });
});

describe("model selection", () => {
  it("only connects after a real-shaped probe, persists selection, restores and invalidates failed calls", async () => {
    const { root, executable } = fake(`
      if (process.argv.includes('--version')) console.log('fake-cli 1.0');
      else if (process.argv.includes('auth')) console.log(JSON.stringify({loggedIn:true}));
      else console.log('Logged in');
    `);
    const probe = vi.fn().mockResolvedValue({ ok: true });
    const candidates = [
      { provider: "codex" as const, executable },
      { provider: "claude" as const, executable },
    ];
    const models = new LocalModels(root, candidates, probe);
    await models.initialize();
    expect(models.current()).toBeNull();
    expect(models.snapshot().available.every((item) => item.installed)).toBe(
      true,
    );
    await models.connect("codex");
    expect(models.current()?.kind).toBe("codex");
    expect(models.snapshot().verifiedAt).toBeTruthy();
    probe.mockRejectedValueOnce(new Error("failed"));
    await expect(models.connect("claude")).rejects.toThrow("failed");
    expect(models.current()?.kind).toBe("codex");
    await models.connect("claude");
    expect(models.current()?.kind).toBe("claude");
    const saved = readFileSync(join(root, "model-connection.json"), "utf8");
    expect(Object.keys(JSON.parse(saved)).sort()).toEqual(["provider", "verifiedAt"]);
    const restored = new LocalModels(root, candidates, probe);
    await restored.initialize();
    expect(restored.current()?.kind).toBe("claude");
    const selected = restored.current();
    if (selected && "executable" in selected) selected.onError?.("登录失效");
    expect(restored.current()).toBeNull();
    expect(restored.snapshot().status).toBe("error");
  });
  it("failed first probe never persists or exposes a connected model", async () => {
    const { root, executable } = fake(`process.exit(0);`);
    const models = new LocalModels(
      root,
      [{ provider: "codex", executable }],
      async () => {
        throw new Error("no account");
      },
    );
    await expect(models.connect("codex")).rejects.toThrow("no account");
    expect(models.current()).toBeNull();
    expect(models.snapshot().status).toBe("disconnected");
    expect(() => readFileSync(join(root, "model-connection.json"))).toThrow();
  });
});

it("starts file turns in the configured data root while keeping writes scoped to the turn copy", async () => {
  const { initializeWorkspace } = await import("./initialize");
  const { root, executable } = fake(`
    const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2);let input='';
    process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
      const entry=args.find(x=>x.startsWith('mcp_servers.taskpilot_files.args='));const parts=JSON.parse(entry.slice(entry.indexOf('=')+1));const manifest=JSON.parse(fs.readFileSync(parts[1],'utf8'));
      if(!fs.existsSync('.agents/skills/taskpilot-files/SKILL.md'))process.exit(2);
      fs.writeFileSync(path.join(manifest.root,'background/SUMMARY.md'),'updated in copy');
      fs.writeFileSync(args[args.indexOf('--output-last-message')+1],process.cwd());console.log(JSON.stringify({type:'turn.completed'}));
    });
  `);
  initializeWorkspace(root);
  const before = new Map([["background/SUMMARY.md", "original"]]);
  const result = await runFileTurn(
    { kind: "codex", executable, workingDirectory: root },
    before,
    ["background/"],
    "Controlled data-root check",
    new AbortController().signal,
  );
  expect(result.reply).toBe(realpathSync(root));
  expect(result.get("background/SUMMARY.md")).toBe("updated in copy");
  expect(before.get("background/SUMMARY.md")).toBe("original");
});

it("initializes shared agent instructions without overwriting learned agreements", async () => {
  const { initializeWorkspace } = await import("./initialize");
  const root = directory();
  initializeWorkspace(root);
  expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain(
    "先使用可用浏览器查看当前工作台",
  );
  expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
  writeFileSync(join(root, "AGENTS.md"), "已确认的用户约定");
  writeFileSync(join(root, "CLAUDE.md"), "@AGENTS.md\n用户补充");
  const researchPrompt = join(
    root,
    ".agents/skills/taskpilot-files/prompts/background.md",
  );
  expect(readFileSync(researchPrompt, "utf8")).toContain("全面刷新我的背景");
  writeFileSync(researchPrompt, "用户调整后的调研方法");
  initializeWorkspace(root);
  expect(readFileSync(researchPrompt, "utf8")).toBe("用户调整后的调研方法");
  expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(
    "已确认的用户约定",
  );
  expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe(
    "@AGENTS.md\n用户补充",
  );
});

it.each(["print","exec"] as const)("runs the native Trae %s protocol without overriding permissions", async (traeFormat) => {
  const record=join(directory(),"args.json");
  const cli=fake(`const fs=require('node:fs');const args=process.argv.slice(2);fs.writeFileSync(${JSON.stringify(record)},JSON.stringify(args));process.stdin.resume();process.stdin.on('end',()=>{if(args.includes('--output-last-message'))fs.writeFileSync(args[args.indexOf('--output-last-message')+1],'Trae 完成');else console.log('Trae 完成');});`);
  const result=await runFileTurn({kind:"trae",traeFormat,executable:cli.executable},new Map(),[],"普通工作",new AbortController().signal);
  expect(result.reply?.trim()).toBe("Trae 完成");
  const args=JSON.parse(readFileSync(record,"utf8"));
  expect(args).not.toContain('--permission-mode'); expect(args).not.toContain('--yolo'); expect(args).not.toContain('--ignore-user-config');
  expect(args).toContain(traeFormat === "print" ? "--print" : "exec");
});

it("restores a verified legacy Trae selection without sending unsupported login commands to its agent", async () => {
  const cli=fake(`const args=process.argv.slice(2);if(args[0]==='--version')console.log('coco version 0.120.47');else process.exit(91);`);
  writeFileSync(join(cli.root,"model-connection.json"),JSON.stringify({provider:"trae",verifiedAt:new Date().toISOString()}));
  const models=new LocalModels(cli.root,[{provider:"trae",executable:cli.executable}]);
  await models.initialize();
  expect(models.current()?.traeFormat).toBe("print");
  expect(models.snapshot().status).toBe("connected");
});

it.each([
  { kind: "codex" }, { kind: "claude" },
  { kind: "trae", traeFormat: "print" }, { kind: "trae", traeFormat: "exec" },
] as const)("uses native model defaults for $kind $traeFormat probes and turns", async (choice) => {
  const record = join(directory(), "calls.jsonl");
  const { executable } = fake(`
    const fs = require('node:fs'); const args = process.argv.slice(2);
    fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify(args)+'\\n');
    process.stdin.resume(); process.stdin.on('end', () => {
      if (args.includes('--output-last-message')) {
        fs.writeFileSync(args[args.indexOf('--output-last-message')+1], JSON.stringify({ok:true}));
        console.log('{"type":"turn.completed"}');
      } else if (args.includes('--json-schema') || args[args.indexOf('--output-format')+1] === 'json') {
        console.log(JSON.stringify({is_error:false,subtype:'success',structured_output:{ok:true},result:'完成'}));
      } else console.log('{"ok":true}');
    });
  `);
  const config: CliModelConfig = { ...choice, executable };
  await cliJson(config, "test", {}, z.object({ ok: z.literal(true) }));
  const onProgress = vi.fn();
  await runFileTurn(config, new Map(), [], "test", new AbortController().signal, { runId: "progress-check", onProgress });
  expect(onProgress.mock.calls[0]?.[0]).toBe("正在准备本轮资料");
  expect(onProgress.mock.calls.some(([stage]) => stage.startsWith("AI 已启动"))).toBe(true);
  expect(onProgress.mock.calls.at(-1)?.[0]).toBe("正在保存结果");
  const calls = readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
  expect(calls).toHaveLength(2);
  for (const args of calls) {
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--effort");
    expect(args).not.toContain("--reasoning-effort");
    expect(args).not.toContain("--ignore-user-config");
    expect(args.some((arg) => /^(model\.name|model_reasoning_effort)=/.test(arg))).toBe(false);
  }
});

it("does not start native work while a model selection is being validated", async () => {
  const { root, executable } = fake(`console.log('fake-cli');`);
  let finish!: () => void;
  const probe = vi.fn().mockResolvedValue({ ok: true });
  const models = new LocalModels(root, [{ provider: "codex", executable }], probe);
  await models.initialize(); await models.connect("codex");
  probe.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const pending = models.connect("codex");
  expect(models.current()).toBeNull();
  expect(models.snapshot().status).toBe("checking");
  finish(); await pending;
  expect(models.current()?.kind).toBe("codex");
});

it("uses the same native Claude authentication for connecting, restarting and running work", async () => {
  const root = directory(), configRoot = directory(), record = join(root, "calls.jsonl");
  vi.stubEnv("CLAUDE_CONFIG_DIR", configRoot);
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "stale-token");
  vi.stubEnv("ANTHROPIC_BASE_URL", "https://stale.invalid");
  writeFileSync(join(configRoot, "settings.json"), JSON.stringify({ apiKeyHelper: "test-helper", env: { ANTHROPIC_BASE_URL: "https://saved.invalid" } }));
  mkdirSync(join(root, ".claude"));
  const { executable } = fake(`
    const fs = require('node:fs'); const args = process.argv.slice(2);
    if(args.includes('--version')) { console.log('claude 2.1.260'); process.exit(0); }
    fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({args, cwd:process.cwd(), route:process.env.ANTHROPIC_BASE_URL, hasOldToken:!!process.env.ANTHROPIC_AUTH_TOKEN})+'\\n');
    process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify(args.includes('auth') ? {loggedIn:true} : {is_error:false,subtype:'success',structured_output:{ok:true},result:'完成'})));
  `);
  initializeWorkspace(root);
  const candidates = [{ provider: "claude" as const, executable }];
  const models = new LocalModels(root, candidates);
  await models.initialize(); await models.connect("claude");
  const restored = new LocalModels(root, candidates);
  await restored.initialize();
  await runFileTurn(restored.current()!, new Map(), [], "controlled test", new AbortController().signal);
  const calls = readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(calls).toHaveLength(3);
  for (const call of calls) expect(call).toMatchObject({ cwd: realpathSync(root), route: "https://saved.invalid", hasOldToken: false });
  expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe("stale-token");
});

it("does not report a started process when the executable cannot launch", async () => {
  const root = directory(), onSpawn = vi.fn();
  await expect(runCli(join(root, "missing-cli"), [], { cwd: root, onSpawn })).rejects.toThrow("无法启动");
  expect(onSpawn).not.toHaveBeenCalled();
});
