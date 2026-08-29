import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function createTempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-test-"));
  // os.tmpdir() can be an 8.3 short name on Windows; hand tests the canonical
  // spelling so path equality assertions do not depend on the machine.
  return fs.realpathSync.native(dir);
}

export function cleanupDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
