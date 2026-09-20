import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { z } from "zod";
import { type ModelConnection, localProviderSchema } from "../core";
import { claudeEnvironment } from "./claude-environment";
import {
  cliJson,
  runCli,
  type CliModelConfig,
  type CliProvider,
} from "./cli-model";

const labels = { codex: "Codex", claude: "Claude Code", trae: "Trae CLI" };
const savedSchema = z.object({
  provider: localProviderSchema,
  verifiedAt: z.string().datetime(),
});
type Candidate = {
  provider: CliProvider;
  executable: string | null;
  traeFormat?: "print" | "exec";
};

// Discovery is explicitly called by the server, never by default unit tests.
export async function discoverLocalModels(): Promise<Candidate[]> {
  return Promise.all(
    (["codex", "claude", "trae"] as const).map(async (provider) => {
      const command = provider === "trae" ? "traecli" : provider;
      const override = process.env[`TASKPILOT_${provider.toUpperCase()}_PATH`];
      const paths = override
        ? [override]
        : [
            ...(process.env.PATH || "")
              .split(delimiter)
              .filter(Boolean)
              .map((directory) => join(directory, command)),
            join(homedir(), ".local/bin", command),
            ...(provider === "codex"
              ? ["/Applications/ChatGPT.app/Contents/Resources/codex"]
              : []),
          ];
      for (const path of [...new Set(paths)]) {
        try {
          await access(path, constants.X_OK);
          return {
            provider,
            executable: path,
          };
        } catch {
          /* Try the next known installation path. */
        }
      }
      return { provider, executable: null };
    }),
  );
}

export class LocalModels {
  private active: CliModelConfig | null = null;
  private stopping = new AbortController();
  private connection: ModelConnection;
  private file: string;
  constructor(
    private dataDir: string,
    private candidates: Candidate[],
    private probe: (
      config: CliModelConfig,
      signal: AbortSignal,
    ) => Promise<unknown> = (config, signal) =>
      cliJson(
        config,
        "Return the requested JSON. Do not use tools.",
        { instruction: "Return ok=true. This is a connection check." },
        z.object({ ok: z.literal(true) }),
        signal,
      ),
  ) {
    this.file = join(dataDir, "model-connection.json");
    this.connection = {
      provider: null,
      label: "模型未连接",
      status: "disconnected",
      verifiedAt: null,
      error: null,
      available: candidates.map((item) => ({
        provider: item.provider,
        label: labels[item.provider],
        installed: false,
        version: "",
      })),
    };
  }
  current() {
    return this.connection.status === "checking" ? null : this.active;
  }
  snapshot(): ModelConnection {
    return structuredClone(this.connection);
  }
  stop() {
    this.stopping.abort();
  }
  private config(provider: CliProvider): CliModelConfig {
    const candidate = this.candidates.find(
      (item) => item.provider === provider,
    );
    if (!candidate?.executable)
      throw new Error(`${labels[provider]} 未安装，请先在本机安装并登录。`);
    return {
      kind: provider,
      executable: candidate.executable,
      traeFormat: candidate.traeFormat,
      workingDirectory: this.dataDir,
      onError: (message) => {
        if (this.connection.provider === provider) {
          this.active = null;
          this.connection.status = "error";
          this.connection.error = message;
        }
      },
    };
  }
  async initialize() {
    for (const candidate of this.candidates) {
      if (!candidate.executable) continue;
      const item = this.connection.available.find(
        (value) => value.provider === candidate.provider,
      )!;
      try {
        item.version = (
          await runCli(candidate.executable, ["--version"], {
            cwd: tmpdir(),
            timeoutMs: 5000,
          })
        )
          .trim()
          .slice(0, 100);
        item.installed = true;
        if (candidate.provider === "trae") candidate.traeFormat = /^coco\b/i.test(item.version) ? "print" : "exec";
      } catch {
        item.installed = false;
      }
    }
    try {
      const saved = savedSchema.parse(
        JSON.parse(await readFile(this.file, "utf8")),
      );
      if (
        !this.connection.available.some(
          (item) => item.provider === saved.provider && item.installed,
        )
      )
        return;
      const config = this.config(saved.provider);
      const legacyTrae = saved.provider === "trae" && config.traeFormat === "print";
      const auth = legacyTrae ? "" : await runCli(
        config.executable,
        saved.provider !== "claude"
          ? ["login", "status"]
          : ["auth", "status", "--json"],
        { cwd: this.dataDir, timeoutMs: 10000, env: saved.provider === "claude" ? await claudeEnvironment(this.dataDir) : undefined },
      );
      if (
        saved.provider === "claude" &&
        !z.object({ loggedIn: z.literal(true) }).safeParse(JSON.parse(auth))
          .success
      )
        return;
      this.active = config;
      Object.assign(this.connection, {
        provider: saved.provider,
        label: labels[saved.provider],
        status: "connected",
        verifiedAt: saved.verifiedAt,
      });
    } catch {
      /* A missing, invalid, or logged-out selection remains disconnected. */
    }
  }
  async connect(provider: CliProvider) {
    if (this.connection.status === "checking")
      throw new Error("正在验证本地连接，请稍等。");
    const previous = this.snapshot();
    const config = this.config(provider);
    this.connection.status = "checking";
    this.connection.error = null;
    try {
      await this.probe({ ...config, onError: undefined }, this.stopping.signal);
      const verifiedAt = new Date().toISOString();
      await mkdir(join(this.file, ".."), { recursive: true, mode: 0o700 });
      await writeFile(
        `${this.file}.tmp`,
        JSON.stringify({ provider, verifiedAt }),
        { mode: 0o600 },
      );
      await rename(`${this.file}.tmp`, this.file);
      this.active = config;
      Object.assign(this.connection, {
        provider,
        label: labels[provider],
        status: "connected",
        verifiedAt,
        error: null,
      });
    } catch (error) {
      this.connection = previous;
      throw error;
    }
  }
}
