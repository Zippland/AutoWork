import {
  readFileSync,
  writeFileSync,
  renameSync,
  lstatSync,
  readdirSync,
  mkdirSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import process from "node:process";
import { Buffer } from "node:buffer";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
const root = resolve(manifest.root);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const directories = manifest.directories || [];
const withinDirectory = (name) =>
  directories.some((directory) => name.startsWith(directory));
function filePath(name, write = false, create = false) {
  if (
    typeof name !== "string" ||
    !name ||
    name.startsWith("/") ||
    name.includes("\\") ||
    [...name].some((character) => character.charCodeAt(0) < 32) ||
    name.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw Error("Invalid relative file path.");
  if (!Object.hasOwn(manifest.files, name) && !withinDirectory(name))
    throw Error("File is outside this turn's permitted scope.");
  if (write && !manifest.files[name] && !withinDirectory(name))
    throw Error("This file is read-only for this turn.");
  const path = resolve(root, name);
  if (!path.startsWith(root + "/") || lstatSync(root).isSymbolicLink())
    throw Error("Only regular workspace files are allowed.");
  let parent = root;
  for (const part of name.split("/")) {
    parent = resolve(parent, part);
    try {
      const info = lstatSync(parent);
      if (
        info.isSymbolicLink() ||
        (parent === path ? !info.isFile() : !info.isDirectory())
      )
        throw Error("Only regular workspace files are allowed.");
    } catch (error) {
      if (!create || error.code !== "ENOENT") throw error;
    }
  }
  return path;
}
function listFiles() {
  const files = new Map(
    Object.entries(manifest.files).filter(([name]) =>
      existsSync(resolve(root, name)),
    ),
  );
  const walk = (name) => {
    const path = resolve(root, name);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw Error("Symbolic links are not allowed.");
    if (info.isDirectory())
      for (const child of readdirSync(path)) walk(`${name}/${child}`);
    else {
      filePath(name);
      files.set(name, true);
    }
  };
  for (const directory of directories)
    if (existsSync(resolve(root, directory)))
      walk(directory.replace(/\/$/, ""));
  if (files.size > 2000) throw Error("Too many workspace files.");
  return [...files].map(([path, writable]) => ({ path, writable }));
}
const string = { type: "string" };
const tools = [
  {
    name: "list_files",
    description:
      "List the documents available for this turn and whether they can be edited.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description:
      "Read a document, including its current SHA-256 for subsequent edits. Read SKILL.md first.",
    inputSchema: {
      type: "object",
      properties: { path: string },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description:
      "Replace one permitted file in the turn workspace. The host validates all changes when the turn ends, before publishing to the board.",
    inputSchema: {
      type: "object",
      properties: { path: string, content: string, expectedHash: string },
      required: ["path", "content", "expectedHash"],
      additionalProperties: false,
    },
  },
  {
    name: "replace_text",
    description:
      "Replace an exact unique text block in a permitted file while preserving all other content.",
    inputSchema: {
      type: "object",
      properties: {
        path: string,
        oldText: string,
        newText: string,
        expectedHash: string,
      },
      required: ["path", "oldText", "newText", "expectedHash"],
      additionalProperties: false,
    },
  },
];
tools.push(
  {
    name: "create_file",
    description:
      "Create a new text file in a writable directory. Choose filenames and subdirectories freely. Fails if the file exists.",
    inputSchema: {
      type: "object",
      properties: { path: string, content: string },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_file",
    description:
      "Remove an obsolete note in a writable directory, after reading it. SUMMARY.md and SUMMARY.md must remain.",
    inputSchema: {
      type: "object",
      properties: { path: string, expectedHash: string },
      required: ["path", "expectedHash"],
      additionalProperties: false,
    },
  },
);
const server = new Server(
  { name: "taskpilot-files", version: "1.0.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((tool) => ({
    ...tool,
    annotations: {
      readOnlyHint: ["list_files", "read_file"].includes(tool.name),
      destructiveHint: tool.name === "delete_file",
      openWorldHint: false,
    },
  })),
}));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  try {
    const args = params.arguments || {};
    let result;
    if (params.name === "list_files")
      result = { files: listFiles(), writableDirectories: directories };
    else if (params.name === "read_file") {
      const content = readFileSync(filePath(args.path), "utf8");
      result = { path: args.path, sha256: hash(content), content };
    } else if (params.name === "create_file") {
      if (!withinDirectory(args.path))
        throw Error("Creation requires a writable directory.");
      const path = filePath(args.path, true, true);
      if (
        typeof args.content !== "string" ||
        args.content.includes("\0") ||
        Buffer.byteLength(args.content) > 4000000
      )
        throw Error("Content must be text no larger than 4 MB.");
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, args.content, { mode: 0o600, flag: "wx" });
      result = { path: args.path, sha256: hash(args.content), saved: true };
    } else if (params.name === "delete_file") {
      if (
        !withinDirectory(args.path) ||
        args.path === "background/SUMMARY.md" ||
        args.path.endsWith("/SUMMARY.md")
      )
        throw Error(
          "Preserve SUMMARY.md and SUMMARY.md; archive cards instead.",
        );
      const path = filePath(args.path, true);
      if (hash(readFileSync(path, "utf8")) !== args.expectedHash)
        throw Error("File changed. Read it again.");
      unlinkSync(path);
      result = { path: args.path, removed: true };
    } else if (["write_file", "replace_text"].includes(params.name)) {
      const path = filePath(args.path, true);
      const original = readFileSync(path, "utf8");
      if (hash(original) !== args.expectedHash)
        throw Error("File changed. Read its current content before editing.");
      let content = args.content;
      if (params.name === "replace_text") {
        if (
          typeof args.oldText !== "string" ||
          !args.oldText ||
          typeof args.newText !== "string" ||
          original.split(args.oldText).length !== 2
        )
          throw Error("oldText must match exactly once.");
        content = original.replace(args.oldText, () => args.newText);
      }
      if (typeof content !== "string" || Buffer.byteLength(content) > 4000000)
        throw Error("Content must be text no larger than 4 MB.");
      const temporary = `${path}.${randomUUID()}.tmp`;
      writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
      renameSync(temporary, path);
      result = { path: args.path, sha256: hash(content), saved: true };
    } else throw Error("Unknown tool.");
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text:
            error instanceof Error ? error.message : "File operation failed.",
        },
      ],
    };
  }
});
await server.connect(new StdioServerTransport());
