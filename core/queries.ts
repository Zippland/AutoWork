import { queryOptions } from "@tanstack/react-query";
import {
  mapKeys,
  snapshotResponseSchema,
  type Command,
  type Snapshot,
} from "./schema";

async function readResponse(response: Response): Promise<Snapshot> {
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const error =
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof body.error === "string"
        ? body.error
        : `HTTP ${response.status}`;
    throw new Error(error);
  }
  const parsed = snapshotResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("服务响应格式异常，请刷新后重试。");
  const snapshot = parsed.data;
  return snapshot;
}

export const pilotStateOptions = () =>
  queryOptions({
    queryKey: ["pilot", "local", "state"],
    queryFn: () => fetch("/api/pilot/state").then(readResponse),
    refetchInterval: 2000,
    retry: 1,
  });

export async function pilotCommand(command: Command): Promise<Snapshot> {
  return readResponse(
    await fetch("/api/pilot/command", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-TaskPilot-Client": "local",
      },
      body: JSON.stringify(mapKeys(command, "snake")),
    }),
  );
}
