import { homedir } from "node:os";
import { resolve } from "node:path";

export function pilotDataDirectory() {
  return resolve(
    process.env.TASKPILOT_DATA_DIR || resolve(homedir(), ".TaskPilot"),
  );
}
