import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  runCommand,
  runCommandChecked,
  binaryAvailable,
  terminateProcessTree,
  formatCommandFailure
} from "../plugins/copilot/scripts/lib/process.mjs";

describe("runCommand", () => {
  it("returns stdout for successful command", () => {
    const result = runCommand("echo", ["hello"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /hello/);
  });

  it("returns error for missing binary", () => {
    const result = runCommand("nonexistent-binary-xyz");
    assert.ok(result.error);
    assert.equal(result.error.code, "ENOENT");
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
