import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  runCommand,
  runCommandChecked,
  binaryAvailable,
  resolveBinary,
  terminateProcessTree,
  formatCommandFailure
} from "../plugins/copilot/scripts/lib/process.mjs";

describe("resolveBinary", () => {
  it("finds node on every platform", () => {
    assert.ok(resolveBinary("node"));
  });

  it("prefers PATHEXT candidates over npm's extensionless POSIX shim", { skip: process.platform !== "win32" }, (t) => {
    const resolved = resolveBinary("npm");
    if (!resolved) {
      t.skip("npm not on PATH");
      return;
    }
    assert.match(resolved, /\.(cmd|exe)$/i);
  });
});

describe("runCommand", () => {
  it("returns stdout for successful command", () => {
    const result = runCommand("echo", ["hello"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /hello/);
  });

  // Audit H1 / task P0-1. On Windows every runCommand goes through cmd.exe
  // (`shell: true`), which re-parses the joined arguments: a git ref carrying
  // `&&` runs a second command. Refs come from the user (`--base`) and from the
  // remote (origin/HEAD), so this is an injection, not a quoting nit.
  it(
    "does not let an argument reach a shell (git ref with && must not execute)",
    { todo: "P0-1: run git without shell; shell only for .cmd/.bat shims", skip: process.platform !== "win32" },
    () => {
      const result = runCommand("git", ["rev-parse", "HEAD&&echo INJECTED_VIA_SHELL"], { cwd: process.cwd() });
      assert.ok(!result.stdout.includes("INJECTED_VIA_SHELL"), "argument was interpreted by a shell");
    }
  );

  it("fails for a missing binary", () => {
    // The shape of the failure is platform-dependent: POSIX surfaces spawn's
    // ENOENT, while on Windows the command goes through cmd.exe, which reports
    // a plain non-zero exit. Both must be recognizable as a failure.
    const result = runCommand("nonexistent-binary-xyz");
    assert.ok(result.error || result.status !== 0);
    if (result.error) {
      assert.equal(result.error.code, "ENOENT");
    }
  });
});

describe("resolveBinary", () => {
  it("finds a binary that exists on PATH", () => {
    assert.ok(resolveBinary("node"));
  });

  it("returns null for a binary that does not exist", () => {
    assert.equal(resolveBinary("nonexistent-binary-xyz"), null);
  });

  it("returns null for an empty command", () => {
    assert.equal(resolveBinary(""), null);
  });
});

describe("binaryAvailable", () => {
  it("reports a present binary as available", () => {
    const result = binaryAvailable("node");
    assert.equal(result.available, true);
  });

  it("reports a missing binary as not found, whatever the shell language", () => {
    const result = binaryAvailable("nonexistent-binary-xyz");
    assert.equal(result.available, false);
    assert.equal(result.detail, "not found");
  });
});

describe("runCommandChecked", () => {
  it("returns result for successful command", () => {
    const result = runCommandChecked("echo", ["hello"]);
    assert.match(result.stdout, /hello/);
  });

  it("throws for failed command", () => {
    assert.throws(() => runCommandChecked("false"), /exit=1|exit=255/);
  });
});

describe("binaryAvailable", () => {
  it("returns available for node", () => {
    const result = binaryAvailable("node", ["--version"]);
    assert.equal(result.available, true);
    assert.match(result.detail, /v\d+/);
  });

  it("returns unavailable for missing binary", () => {
    const result = binaryAvailable("nonexistent-binary-xyz");
    assert.equal(result.available, false);
  });
});

describe("terminateProcessTree", () => {
  it("returns attempted=false for non-finite pid", () => {
    const result = terminateProcessTree(Number.NaN);
    assert.equal(result.attempted, false);
  });

  it("returns delivered=false for nonexistent pid", () => {
    const result = terminateProcessTree(999999999);
    assert.equal(result.attempted, true);
    assert.equal(result.delivered, false);
  });
});

describe("formatCommandFailure", () => {
  it("formats basic failure", () => {
    const msg = formatCommandFailure({ command: "test", args: ["arg"], status: 1, stderr: "err" });
    assert.match(msg, /test arg/);
    assert.match(msg, /exit=1/);
    assert.match(msg, /err/);
  });
});
