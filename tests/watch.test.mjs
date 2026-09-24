import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createTempWorkspace, cleanupDir } from "./helpers.mjs";
import {
  classifyLogLine,
  formatMinutes,
  latestNarration,
  renderEndLine,
  splitCompleteLines
} from "../lib/watch.mjs";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(TESTS_DIR, "..", "bin", "copilot-plugin.mjs");
const FIXTURE = path.resolve(TESTS_DIR, "fake-copilot-fixture.mjs");

describe("watch: log lines to events", () => {
  it("reports a command with its exit code", () => {
    assert.equal(
      classifyLogLine("[2026-09-24T17:00:00.000Z] Ran command: pytest tests -q (exit 4)."),
      "CMD command: pytest tests -q (exit 4)"
    );
  });

  it("reports a refused request with what was refused", () => {
    assert.equal(
      classifyLogLine("[2026-09-24T17:00:00.000Z] Denied command: cmd /c echo (workspace-write)."),
      "DENIED command: cmd /c echo (workspace-write)"
    );
  });

  it("reports an escalation", () => {
    assert.equal(
      classifyLogLine("[2026-09-24T17:00:00.000Z] Paused for approval: write outside fence."),
      "PAUSED write outside fence"
    );
  });

  it("ignores tool chatter, block bodies and unprefixed lines", () => {
    assert.equal(classifyLogLine("[2026-09-24T17:00:00.000Z] Running tool: view."), null);
    assert.equal(classifyLogLine("[2026-09-24T17:00:00.000Z] Tool edit completed."), null);
    assert.equal(classifyLogLine("Ran command: this is a block body, not a log line"), null);
    assert.equal(classifyLogLine(""), null);
  });

  it("keeps a partial last line for the next read", () => {
    assert.deepEqual(splitCompleteLines("a\r\nb\nc"), { lines: ["a", "b"], rest: "c" });
    assert.deepEqual(splitCompleteLines("a\n"), { lines: ["a"], rest: "" });
  });

  it("shows the tail of the narration on one line", () => {
    assert.equal(latestNarration("  one\n two  "), "one two");
    assert.equal(latestNarration("x".repeat(10) + "tail", 4), "...tail");
    assert.equal(latestNarration(undefined), "");
  });

  it("formats whole minutes", () => {
    assert.equal(formatMinutes(0), "0m");
    assert.equal(formatMinutes(125_000), "2m");
  });

  it("ends with the next command: result for a finished job", () => {
    assert.equal(
      renderEndLine({ id: "task-1", status: "completed-degraded", deniedCount: 2 }),
      "END status=completed-degraded | denied=2 | next: result task-1"
    );
  });

  it("ends with approve or deny for a paused job, naming the request", () => {
    assert.equal(
      renderEndLine({ id: "task-2", status: "awaiting-approval", pendingApproval: { request: "rm -rf dist" } }),
      "END status=awaiting-approval | request=rm -rf dist | next: approve task-2 or deny task-2"
    );
  });

  it("carries a failure's message on one line", () => {
    assert.equal(
      renderEndLine({ id: "task-3", status: "failed", errorMessage: "Timeout after\n1800000ms" }),
      "END status=failed | error=Timeout after 1800000ms | next: result task-3"
    );
  });
});

describe("watch: the CLI", () => {
  let repo;
  let env;

  function run(args, options = {}) {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: repo,
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
      COPILOT_PLUGIN_SESSION_ID: "watch-test-session"
    };
  });

  after(() => cleanupDir(repo));

  it("requires a job id", () => {
    const result = run(["watch"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /`watch` requires a job id/);
  });

  it("replays the log's events, then ends at once on a finished job", () => {
    const task = run(["task", "--json", "say hello"], {
      env: { COPILOT_FAKE_CONFIG: JSON.stringify({ session: { response: "Hello." } }) }
    });
    assert.equal(task.status, 0, task.stderr);
    const job = JSON.parse(run(["status", "--json"]).stdout).latestFinished;
    assert.ok(job.logFile, "the finished job names its log");

    // What a real run writes: one command that failed, one refusal, and chatter.
    fs.appendFileSync(
      job.logFile,
      [
        "[2026-09-24T17:00:00.000Z] Running tool: run_command.",
        "[2026-09-24T17:00:01.000Z] Ran command: pytest -q (exit 4).",
        "[2026-09-24T17:00:02.000Z] Denied command: cmd /c echo (workspace-write).",
        ""
      ].join("\n")
    );

    const watched = run(["watch", job.id, "--beat-seconds", "0", "--silence-seconds", "0"]);
    assert.equal(watched.status, 0, watched.stderr);
    const lines = watched.stdout.trim().split(/\r?\n/);
    assert.deepEqual(lines, [
      "CMD command: pytest -q (exit 4)",
      "DENIED command: cmd /c echo (workspace-write)",
      `END status=completed | next: result ${job.id}`
    ]);

    // Re-arming a watch must not replay what the caller already saw.
    const rearmed = run(["watch", job.id, "--since-now"]);
    assert.equal(rearmed.status, 0, rearmed.stderr);
    assert.equal(rearmed.stdout.trim(), `END status=completed | next: result ${job.id}`);
  });
});
