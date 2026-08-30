import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createTempWorkspace, cleanupDir } from "./helpers.mjs";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(TESTS_DIR, "..", "plugins", "copilot");

/**
 * Audit H2 / task P0-2. The marketplace copies plugins/copilot and nothing
 * else: no package.json, no node_modules, and Node's resolution never reaches
 * the repository's node_modules from ~/.claude/plugins/cache. Every command in
 * that copy failed with "@github/copilot-sdk is not installed" and setup told
 * the user to install a different package. This test runs the plugin the way
 * it is installed.
 */
describe("installed copy of the plugin", () => {
  let sandbox;
  let installed;
  let repo;
  let env;

  function companion(args, extraEnv = {}) {
    return spawnSync(process.execPath, [path.join(installed, "scripts", "copilot-companion.mjs"), ...args], {
      cwd: repo,
      env: { ...env, ...extraEnv },
      encoding: "utf8",
      timeout: 120_000
    });
  }

  before(() => {
    sandbox = createTempWorkspace();
    installed = path.join(sandbox, "cache", "copilot-plugin-cc", "copilot", "0.0.0-test");
    fs.cpSync(PLUGIN_DIR, installed, {
      recursive: true,
      filter: (source) => !source.split(path.sep).includes("node_modules")
    });

    repo = path.join(sandbox, "repo");
    fs.mkdirSync(repo);
    execSync("git init", { cwd: repo });
    execSync("git config user.email test@test.com", { cwd: repo });
    execSync("git config user.name Test", { cwd: repo });
    fs.writeFileSync(path.join(repo, "f.txt"), "x\n");
    execSync("git add . && git commit -m init", { cwd: repo });

    // No SDK override: this test is about the real resolution from the copy.
    env = { ...process.env, CLAUDE_PLUGIN_DATA: path.join(sandbox, "data") };
    delete env.COPILOT_COMPANION_SDK_MODULE;
  });

  after(() => cleanupDir(sandbox));

  it("copies the plugin without node_modules", () => {
    assert.ok(fs.existsSync(path.join(installed, "scripts", "copilot-companion.mjs")));
    assert.ok(!fs.existsSync(path.join(installed, "node_modules")));
  });

  it("setup --json runs from the copy without crashing", () => {
    const result = companion(["setup", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.ok("auth" in report);
    assert.ok("copilot" in report);
  });

  it(
    "setup points at the SDK, not at the Copilot CLI package, when the runtime is missing",
    { todo: "P0-2: one remediation message, about @github/copilot-sdk in the plugin directory" },
    () => {
      const result = companion(["setup", "--json"]);
      const report = JSON.parse(result.stdout);
      const text = JSON.stringify(report.nextSteps);
      assert.doesNotMatch(text, /npm install -g @github\/copilot`/, "setup still suggests installing the CLI package instead of the SDK");
      if (report.sdk?.available === false) {
        assert.match(text, /install-runtime/);
      }
    }
  );

  it(
    "setup --install-runtime makes the copy self-sufficient",
    { todo: "P0-2: ship package.json with the plugin and let setup install the SDK into it", skip: process.env.COPILOT_TEST_OFFLINE === "1" },
    () => {
      const install = companion(["setup", "--install-runtime", "--json"]);
      assert.equal(install.status, 0, install.stderr);
      const report = JSON.parse(install.stdout);
      assert.equal(report.sdk?.available, true, JSON.stringify(report.sdk ?? report.auth));
      assert.ok(fs.existsSync(path.join(installed, "node_modules", "@github", "copilot-sdk", "package.json")));

      const again = companion(["setup", "--json"]);
      const second = JSON.parse(again.stdout);
      assert.equal(second.sdk?.available, true);
      assert.notEqual(second.auth.detail, "@github/copilot-sdk is not installed.");
    }
  );
});
