import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  runCommand,
  runCommandChecked,
  binaryAvailable,
  isProcessAlive,
  processCommandLine,
  resolveBinary,
  terminateProcessTree,
  formatCommandFailure
} from "../lib/process.mjs";

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
    // `node` rather than `echo`: without a shell there is no echo builtin on Windows.
    const result = runCommand("node", ["-e", "console.log('hello')"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /hello/);
  });

  // On Windows every runCommand went through cmd.exe
  // (`shell: true`), which re-parses the joined arguments: a git ref carrying
  // `&&` ran a second command. Refs come from the user (`--base`) and from the
  // remote (origin/HEAD), so this was an injection, not a quoting nit.
  it("does not let an argument reach a shell (git ref with && must not execute)", () => {
    const result = runCommand("git", ["rev-parse", "HEAD&&echo INJECTED_VIA_SHELL"], { cwd: process.cwd() });
    // git echoes an unknown ref back verbatim; a shell would print the echo's
    // output as a line of its own.
    const lines = result.stdout.split(/\r?\n/).map((line) => line.trim());
    assert.ok(!lines.includes("INJECTED_VIA_SHELL"), "argument was interpreted by a shell");
    assert.notEqual(result.status, 0, "git should reject the bogus ref");
  });

  it("passes arguments with spaces and quotes through untouched", () => {
    const result = runCommand("node", ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", "a b", "\"quoted\"", "%PATH%", "$HOME"]);
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), ["a b", "\"quoted\"", "%PATH%", "$HOME"]);
  });

  it("still runs .cmd shims on Windows through cmd.exe", { skip: process.platform !== "win32" }, (t) => {
    if (!resolveBinary("npm")) {
      t.skip("npm not on PATH");
      return;
    }
    const result = runCommand("npm", ["--version"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^\d+\.\d+/);
  });

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
    const result = runCommandChecked("node", ["-e", "console.log('hello')"]);
    assert.match(result.stdout, /hello/);
  });

  it("throws for failed command", () => {
    assert.throws(() => runCommandChecked("node", ["-e", "process.exit(1)"]), /exit=1/);
  });

  it("throws ENOENT for a missing binary", () => {
    assert.throws(() => runCommandChecked("nonexistent-binary-xyz"), (error) => error.code === "ENOENT");
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

  // A stored pid can be reused by anything; with an
  // identity predicate the kill only proceeds when the command line matches.
  it("with an identity predicate, leaves a pid that belongs to something else alone", () => {
    const calls = [];
    const runCommandImpl = (command, args) => {
      calls.push([command, ...args]);
      return { command, args, status: 0, stdout: "", stderr: "", error: null };
    };
    const killImpl = () => {
      calls.push(["kill"]);
    };
    const common = { runCommandImpl, killImpl, identity: (line) => line.includes("copilot-plugin.mjs") };

    const foreign = terminateProcessTree(4242, { ...common, commandLineImpl: () => "C:\\Windows\\explorer.exe" });
    assert.equal(foreign.attempted, false);
    assert.match(foreign.reason, /another process/);

    const unknown = terminateProcessTree(4242, { ...common, commandLineImpl: () => null });
    assert.equal(unknown.attempted, false);
    assert.match(unknown.reason, /not found|unreadable/);
    assert.deepEqual(calls, [], "nothing was killed");

    const ours = terminateProcessTree(4242, { ...common, commandLineImpl: () => "node copilot-plugin.mjs task-worker --job-id x", platform: "win32" });
    assert.equal(ours.attempted, true);
    assert.equal(ours.delivered, true);
    assert.deepEqual(calls[0].slice(0, 3), ["taskkill", "/PID", "4242"]);
  });
});

describe("isProcessAlive / processCommandLine", () => {
  it("sees this process and not a bogus pid", () => {
    assert.equal(isProcessAlive(process.pid), true);
    assert.equal(isProcessAlive(999999999), false);
    assert.equal(isProcessAlive(Number.NaN), false);
  });

  it("reads this process's own command line", () => {
    const line = processCommandLine(process.pid);
    assert.ok(line, "command line could not be read on this platform");
    assert.match(line, /node/i);
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
