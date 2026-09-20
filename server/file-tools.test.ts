// @vitest-environment node
import { expect, it } from "vitest";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  symlink,
  mkdir,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

it("exposes bounded file edits with hash checks, read-only files and no path/symlink escape", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pilot-file-tools-"));
  const scope = join(directory, "scope.json");
  await writeFile(join(directory, "task.md"), "original text");
  await writeFile(join(directory, "readonly.json"), "{}");
  await symlink(join(directory, "readonly.json"), join(directory, "link.md"));
  await writeFile(
    scope,
    JSON.stringify({
      root: directory,
      files: { "task.md": true, "readonly.json": false, "link.md": true },
    }),
  );
  const client = new Client({ name: "controlled-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("./file-tools.mjs", import.meta.url)), scope],
  });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "list_files",
      "read_file",
      "write_file",
      "replace_text",
      "create_file",
      "delete_file",
    ]);
    const read = await client.callTool({
      name: "read_file",
      arguments: { path: "task.md" },
    });
    const data = JSON.parse((read.content as { text: string }[])[0]!.text);
    expect(data.content).toBe("original text");
    expect(
      (
        await client.callTool({
          name: "replace_text",
          arguments: {
            path: "task.md",
            oldText: "original",
            newText: "更新",
            expectedHash: data.sha256,
          },
        })
      ).isError,
    ).not.toBe(true);
    expect(await readFile(join(directory, "task.md"), "utf8")).toBe(
      "更新 text",
    );
    expect(
      (
        await client.callTool({
          name: "write_file",
          arguments: {
            path: "task.md",
            content: "stale",
            expectedHash: data.sha256,
          },
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await client.callTool({
          name: "write_file",
          arguments: {
            path: "readonly.json",
            content: "changed",
            expectedHash: "anything",
          },
        })
      ).isError,
    ).toBe(true);
    for (const path of [
      "../scope.json",
      "scope.json",
      "/etc/passwd",
      "link.md",
    ])
      expect(
        (await client.callTool({ name: "read_file", arguments: { path } }))
          .isError,
      ).toBe(true);
    expect(await readFile(join(directory, "readonly.json"), "utf8")).toBe("{}");
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("supports free background notes while blocking directory escapes, stale deletion and summary removal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pilot-background-tools-"));
  const scope = join(directory, "scope.json");
  await mkdir(join(directory, "background"));
  await writeFile(join(directory, "background/SUMMARY.md"), "总结");
  await symlink(directory, join(directory, "background/escape"));
  await writeFile(
    scope,
    JSON.stringify({
      root: directory,
      files: {},
      directories: ["background/"],
    }),
  );
  const client = new Client({ name: "controlled-test", version: "1" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          fileURLToPath(new URL("./file-tools.mjs", import.meta.url)),
          scope,
        ],
      }),
    );
    const create = (path: string) =>
      client.callTool({
        name: "create_file",
        arguments: { path, content: "自由整理的笔记" },
      });
    expect((await create("background/notes/最近.md")).isError).not.toBe(true);
    expect((await create("background/notes/最近.md")).isError).toBe(true);
    for (const path of [
      "background/../outside.md",
      "background/escape/outside.md",
      "background//bad.md",
      "tasks/new.md",
    ])
      expect((await create(path)).isError).toBe(true);
    const read = await client.callTool({
      name: "read_file",
      arguments: { path: "background/notes/最近.md" },
    });
    const data = JSON.parse((read.content as { text: string }[])[0]!.text);
    expect(
      (
        await client.callTool({
          name: "delete_file",
          arguments: {
            path: "background/notes/最近.md",
            expectedHash: "stale",
          },
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await client.callTool({
          name: "delete_file",
          arguments: {
            path: "background/notes/最近.md",
            expectedHash: data.sha256,
          },
        })
      ).isError,
    ).not.toBe(true);
    expect(
      (
        await client.callTool({
          name: "delete_file",
          arguments: { path: "background/SUMMARY.md", expectedHash: "any" },
        })
      ).isError,
    ).toBe(true);
    expect(
      await readFile(join(directory, "background/SUMMARY.md"), "utf8"),
    ).toBe("总结");
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
