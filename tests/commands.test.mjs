import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createTempWorkspace, cleanupDir } from "./helpers.mjs";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(TESTS_DIR, "..", "bin", "copilot-plugin.mjs");
const FIXTURE = path.resolve(TESTS_DIR, "fake-copilot-fixture.mjs");

/**
 * The CLI as Claude Code invokes it: a spawned node process, a real git repo,
 * its own state directory, and the fake SDK standing in for Copilot. Every
 * assertion here is on concrete output; a crash is a failure, not "acceptable".
 */
describe("copilot-plugin CLI", () => {
  let repo;
  let env;

  function run(args, options = {}) {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: options.cwd ?? repo,
      env: { ...env, ...(options.env ?? {}) },
      encoding: "utf8",
      timeout: 60_000
    });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  before(() => {
    repo = createTempWorkspace();
    execSync("git init", { cwd: repo });
    execSync("git config user.email test@test.com", { cwd: repo });
    execSync("git config user.name Test", { cwd: repo });
    fs.writeFileSync(path.join(repo, "f.txt"), "x\n");
    execSync("git add . && git commit -m init", { cwd: repo });
    env = {
      ...process.env,
      CLAUDE_PLUGIN_DATA: path.join(repo, ".plugin-data"),
      COPILOT_PLUGIN_SDK_MODULE: FIXTURE,
      COPILOT_PLUGIN_SESSION_ID: "cli-test-session"
    };
  });

  after(() => cleanupDir(repo));

  it("prints usage for help and --help", () => {
    for (const flag of ["help", "--help"]) {
      const result = run([flag]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /^Usage:/);
      assert.match(result.stdout, /copilot-plugin\.mjs setup/);
    }
  });

  it("exits with an error for an unknown subcommand", () => {
    const result = run(["nonexistent"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown subcommand: nonexistent/);
  });

  // Any error whose text contained "auth" or "login" was
  // rewritten into "Copilot authentication failed", including this one.
  it("reports an unknown subcommand as such even when its name contains 'auth'", () => {
    const result = run(["authors"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown subcommand: authors/);
    assert.doesNotMatch(result.stderr, /authentication failed/);
  });

  it("setup --json reports the fake runtime as ready", () => {
    const result = run(["setup", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ready, true);
    assert.equal(report.sdk.source, "override");
    assert.equal(report.copilot.source, "override");
    assert.equal(report.auth.loggedIn, true);
    assert.ok(report.models.includes("gpt-5.4"));
    assert.equal(report.reviewGateEnabled, false);
  });

  it("status renders the report header with no jobs recorded", () => {
    const result = run(["status"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^# Copilot Status/);
    assert.match(result.stdout, /No jobs recorded yet/);
  });

  it("rejects an unsupported reasoning effort before touching the runtime", () => {
    const result = run(["review", "--effort", "bogus"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unsupported reasoning effort "bogus"/);
  });

  it("approve and deny explain when nothing is waiting", () => {
    for (const subcommand of ["approve", "deny"]) {
      const result = run([subcommand]);
      assert.equal(result.status, 1, subcommand);
      assert.match(result.stderr, /No Copilot jobs are awaiting approval/);
    }
  });

  it("task --wait runs a prompt through the fake SDK and records the job", () => {
    const result = run(["task", "--json", "say hello"], {
      env: { COPILOT_FAKE_CONFIG: JSON.stringify({ session: { response: "Hello from the fake." } }) }
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.rawOutput, "Hello from the fake.");
    assert.ok(payload.sessionId.startsWith("copilot-plugin-task"));

    const status = run(["status", "--json"]);
    const report = JSON.parse(status.stdout);
    assert.equal(report.latestFinished.status, "completed");
    assert.equal(report.latestFinished.kindLabel, "rescue");
  });

  // Last: it leaves a failed job behind, which the status test above must not see.
  it("reports a real authentication failure as one", () => {
    const result = run(["review", "--wait"], {
      env: { COPILOT_FAKE_CONFIG: JSON.stringify({ auth: { isAuthenticated: false, statusMessage: "no token" } }) }
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Copilot authentication failed/);
    assert.match(result.stderr, /copilot login/);
  });
});

describe("copilot-plugin CLI: flags that must not cost anything", () => {
  let repo;
  let env;
  let logFile;

  function run(args) {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: repo,
      env,
      encoding: "utf8",
      timeout: 60_000
    });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  function sdkCalls() {
    if (!fs.existsSync(logFile)) return [];
    return fs
      .readFileSync(logFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line).call);
  }

  before(() => {
    repo = createTempWorkspace();
    execSync("git init", { cwd: repo });
    execSync("git config user.email test@test.com", { cwd: repo });
    execSync("git config user.name Test", { cwd: repo });
    fs.writeFileSync(path.join(repo, "f.txt"), "x\n");
    execSync("git add . && git commit -m init", { cwd: repo });
    logFile = path.join(repo, "sdk-calls.log");
    env = {
      ...process.env,
      CLAUDE_PLUGIN_DATA: path.join(repo, ".plugin-data"),
      COPILOT_PLUGIN_SDK_MODULE: FIXTURE,
      COPILOT_PLUGIN_SESSION_ID: "cli-flag-session",
      COPILOT_FAKE_LOG: logFile
    };
  });

  after(() => cleanupDir(repo));

  // The bug this pays for: `task --help` fell through to the prompt, created a
  // session, and had the model answer the literal text "--help".
  it("task --help prints help without opening a session", () => {
    const result = run(["task", "--help"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: copilot-plugin task/);
    assert.ok(!sdkCalls().includes("createSession"), sdkCalls().join(","));
  });

  it("task --dry-run validates without opening a session", () => {
    const result = run(["task", "--dry-run", "look at src/index.js"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Copilot Dry Run/);
    assert.match(result.stdout, /Ready: yes/);
    assert.ok(!sdkCalls().includes("createSession"), sdkCalls().join(","));
  });

  it("task --dry-run reports a missing --add-dir and exits non-zero", () => {
    const result = run(["task", "--dry-run", "--add-dir", "./definitely-not-here", "do something"]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /definitely-not-here does not exist/);
    assert.match(result.stdout, /Ready: no/);
  });

  it("refuses a mistyped flag instead of sending it as the prompt", () => {
    const result = run(["task", "--backgruond", "fix the bug"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr + result.stdout, /Unknown option --backgruond/);
    assert.ok(!sdkCalls().includes("createSession"));
  });

  it("accepts --read-only and the no-op --wait that callers forward", () => {
    const result = run(["task", "--read-only", "--wait", "--dry-run", "check something"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Permission mode: read-only/);
  });
});
