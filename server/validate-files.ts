import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { systemSchema } from "../core";
import { readModelFiles, validateFiles } from "./workspace-files";
import { pilotDataDirectory } from "./paths";
const directory = resolve(
  process.argv[2] || resolve(pilotDataDirectory(), "workspace"),
);
try {
  systemSchema.parse(
    JSON.parse(readFileSync(resolve(directory, "SYSTEM.json"), "utf8")),
  );
  const issues = validateFiles(readModelFiles(directory));
  if (issues.length)
    throw new Error(
      issues.map((issue) => `${issue.file}: ${issue.message}`).join("\n"),
    );
  console.log("文件验证通过。");
} catch (error) {
  console.error(error instanceof Error ? error.message : "文件验证失败。");
  process.exitCode = 1;
}
