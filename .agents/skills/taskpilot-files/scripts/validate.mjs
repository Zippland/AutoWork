import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const result = spawnSync(process.execPath, ["--import", "tsx", "server/validate-files.ts", ...process.argv.slice(2).map((path) => resolve(path))], {
  cwd: root, stdio: "inherit", shell: false,
});
process.exit(result.status ?? 1);
