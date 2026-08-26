import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function createTempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-test-"));
  return dir;
}

export function cleanupDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
