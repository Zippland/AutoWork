import { expect, it } from "vitest";
import { fileName, localFileUrl } from "./file-preview";

const origin = "http://127.0.0.1:4317";
it("recognizes local file references including Chinese names without hijacking external links or downloads", () => {
  const path = "/api/pilot/files/tasks/DEMO-1/%E8%AF%B4%E6%98%8E%E7%A8%BF.md";
  expect(localFileUrl(path, origin)).toBe(path);
  expect(localFileUrl(origin + path + "#details", origin)).toBe(path + "#details");
  expect(fileName(path)).toBe("tasks/DEMO-1/说明稿.md");
  expect(localFileUrl("https://example.com" + path, origin)).toBeNull();
  expect(localFileUrl(path + "?download=1", origin)).toBeNull();
  expect(localFileUrl("/api/pilot/state", origin)).toBeNull();
  expect(localFileUrl("javascript:alert(1)", origin)).toBeNull();
  expect(localFileUrl("/api/pilot/files/%invalid", origin)).toBeNull();
});
