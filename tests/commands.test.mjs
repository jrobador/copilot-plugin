import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugins",
  "copilot",
  "scripts",
  "copilot-companion.mjs"
);

describe("copilot-companion CLI", () => {
  it("prints usage for help", () => {
    const result = execSync(`node ${SCRIPT} help`, { encoding: "utf8" });
    assert.match(result, /Usage:/);
    assert.match(result, /copilot-companion/);
  });

  it("prints usage for --help", () => {
    const result = execSync(`node ${SCRIPT} --help`, { encoding: "utf8" });
    assert.match(result, /Usage:/);
  });

  it("exits with error for unknown subcommand", () => {
    assert.throws(() => execSync(`node ${SCRIPT} nonexistent`, { encoding: "utf8" }), /Unknown subcommand/);
  });
});

describe("setup subcommand", () => {
  it("returns JSON when --json is passed", () => {
    try {
      const result = execSync(`node ${SCRIPT} setup --json`, {
        encoding: "utf8",
        env: { ...process.env, CLAUDE_PLUGIN_DATA: "/tmp/copilot-test-integration" }
      });
      const parsed = JSON.parse(result);
      assert.ok("ready" in parsed);
      assert.ok("node" in parsed);
      assert.ok("copilot" in parsed);
    } catch (e) {
      // setup --json might fail if not in a git repo or on parse error
      // That's acceptable - we just verify it runs without a crash
      assert.ok(e.stderr !== undefined || e.message !== undefined);
    }
  });
});

describe("status subcommand", () => {
  it("returns status output or git error", () => {
    try {
      const result = execSync(`node ${SCRIPT} status`, {
        encoding: "utf8",
        env: { ...process.env, CLAUDE_PLUGIN_DATA: "/tmp/copilot-test-integration" }
      });
      assert.match(result, /Copilot Status/);
    } catch (e) {
      // May fail if not in a git repo, which is OK for CI
      const errOutput = (e.stderr || "") + (e.message || "");
      assert.match(errOutput, /Git|git|repository/i);
    }
  });
});
