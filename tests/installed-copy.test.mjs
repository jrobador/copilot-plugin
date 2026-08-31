import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createTempWorkspace, cleanupDir } from "./helpers.mjs";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(TESTS_DIR, "..");

/**
 * The marketplace copies the plugin source and nothing
 * else: no node_modules, and Node's resolution never reaches a sibling from
 * ~/.claude/plugins/cache. Every command in that copy failed with
 * "@github/copilot-sdk is not installed" and setup told the user to install a
 * different package. This test runs the plugin the way it is installed: a copy
 * of the repo root without node_modules.
 */
const SKIP_IN_COPY = new Set(["node_modules", ".git", ".github", "tests", "scratch"]);
describe("installed copy of the plugin", () => {
  let sandbox;
  let installed;
  let repo;
  let env;

  function plugin(args, extraEnv = {}) {
    return spawnSync(process.execPath, [path.join(installed, "bin", "copilot-plugin.mjs"), ...args], {
      cwd: repo,
      env: { ...env, ...extraEnv },
      encoding: "utf8",
      timeout: 120_000
    });
  }

  before(() => {
    sandbox = createTempWorkspace();
    installed = path.join(sandbox, "cache", "copilot-plugin", "copilot", "0.0.0-test");
    fs.cpSync(PLUGIN_DIR, installed, {
      recursive: true,
      filter: (source) => !source.split(path.sep).some((seg) => SKIP_IN_COPY.has(seg))
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
    delete env.COPILOT_PLUGIN_SDK_MODULE;
  });

  after(() => cleanupDir(sandbox));

  it("copies the plugin without node_modules", () => {
    assert.ok(fs.existsSync(path.join(installed, "bin", "copilot-plugin.mjs")));
    assert.ok(!fs.existsSync(path.join(installed, "node_modules")));
  });

  it("setup --json runs from the copy without crashing", () => {
    const result = plugin(["setup", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.ok("auth" in report);
    assert.ok("copilot" in report);
  });

  it("setup reports the runtime as missing and points at --install-runtime", () => {
    const result = plugin(["setup", "--json"]);
    const report = JSON.parse(result.stdout);
    assert.equal(report.sdk.available, false, JSON.stringify(report.sdk));
    assert.equal(report.ready, false);
    const text = JSON.stringify(report.nextSteps);
    assert.doesNotMatch(text, /npm install -g @github\/copilot`/, "setup still suggests installing the CLI package instead of the SDK");
    assert.match(text, /install-runtime/);
    assert.match(report.auth.detail, /install-runtime/);
  });

  it("the copy ships the manifest that --install-runtime installs from", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(installed, "package.json"), "utf8"));
    assert.ok(manifest.optionalDependencies["@github/copilot-sdk"]);
    assert.ok(fs.existsSync(path.join(installed, "package-lock.json")), "the lockfile pins what gets installed");
  });

  it(
    "setup --install-runtime makes the copy self-sufficient",
    { skip: process.env.COPILOT_TEST_OFFLINE === "1" ? "COPILOT_TEST_OFFLINE=1" : false },
    () => {
      const install = plugin(["setup", "--install-runtime", "--json"]);
      assert.equal(install.status, 0, install.stderr);
      const report = JSON.parse(install.stdout);
      assert.equal(report.sdk.available, true, JSON.stringify(report.sdk));
      assert.equal(report.sdk.source, "installed");
      assert.ok(report.actionsTaken.some((action) => /Installed the Copilot runtime/.test(action)), JSON.stringify(report.actionsTaken));
      assert.ok(fs.existsSync(path.join(installed, "node_modules", "@github", "copilot-sdk", "package.json")));
      assert.equal(report.copilot.available, true, "the SDK bundles the CLI");
      // The runtime must actually start, not merely resolve: SDK 1.0.11 and
      // CLI 1.0.82 install side by side and then fail to find each other
      // (the platform package dropped the ./sdk export). The pin in
      // package.json exists because of this assertion.
      assert.equal(report.auth.available, true, `runtime did not start: ${report.auth.detail}`);

      const again = plugin(["setup", "--json"]);
      const second = JSON.parse(again.stdout);
      assert.equal(second.sdk.available, true);
      assert.doesNotMatch(second.auth.detail, /not installed/);

      const idempotent = plugin(["setup", "--install-runtime", "--json"]);
      assert.ok(JSON.parse(idempotent.stdout).actionsTaken.some((action) => /already installed/.test(action)));
    }
  );
});
