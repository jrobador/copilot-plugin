import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

import { createTempWorkspace, cleanupDir } from "./helpers.mjs";
import { generateJobId, upsertJob } from "../plugins/copilot/scripts/lib/state.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobRecord,
  SESSION_ID_ENV
} from "../plugins/copilot/scripts/lib/tracked-jobs.mjs";
import {
  enrichJob,
  readJobProgressPreview,
  sortJobsNewestFirst,
  resolveResultJob,
  resolveCancelableJob
} from "../plugins/copilot/scripts/lib/job-control.mjs";

describe("tracked-jobs", () => {
  let tempDir;
  let origEnv;

  before(() => {
    tempDir = createTempWorkspace();
    execSync("git init", { cwd: tempDir });
    execSync("git config user.email test@test.com", { cwd: tempDir });
    execSync("git config user.name Test", { cwd: tempDir });
    fs.writeFileSync(path.join(tempDir, "f.txt"), "x");
    execSync("git add . && git commit -m init", { cwd: tempDir });
    origEnv = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = path.join(tempDir, ".plugin-data");
  });

  after(() => {
    if (origEnv === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = origEnv;
    cleanupDir(tempDir);
  });

  it("SESSION_ID_ENV is COPILOT_COMPANION_SESSION_ID", () => {
    assert.equal(SESSION_ID_ENV, "COPILOT_COMPANION_SESSION_ID");
  });

  it("createJobRecord sets sessionId from env", () => {
    const record = createJobRecord({ id: "test" }, {
      env: { COPILOT_COMPANION_SESSION_ID: "sess-123" }
    });
    assert.equal(record.sessionId, "sess-123");
  });

  it("createJobLogFile creates log and appends title", () => {
    const logFile = createJobLogFile(tempDir, "log-test", "Test Title");
    assert.ok(fs.existsSync(logFile));
    const content = fs.readFileSync(logFile, "utf8");
    assert.match(content, /Starting Test Title/);
  });

  it("appendLogLine writes timestamped lines", () => {
    const logFile = createJobLogFile(tempDir, "append-test", null);
    appendLogLine(logFile, "Hello");
    const content = fs.readFileSync(logFile, "utf8");
    assert.match(content, /\[.*\] Hello/);
  });
});

describe("job-control", () => {
  let tempDir;
  let origEnv;

  before(() => {
    tempDir = createTempWorkspace();
    execSync("git init", { cwd: tempDir });
    execSync("git config user.email test@test.com", { cwd: tempDir });
    execSync("git config user.name Test", { cwd: tempDir });
    fs.writeFileSync(path.join(tempDir, "f.txt"), "x");
    execSync("git add . && git commit -m init", { cwd: tempDir });
    origEnv = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = path.join(tempDir, ".plugin-data");
  });

  after(() => {
    if (origEnv === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = origEnv;
    cleanupDir(tempDir);
  });

  it("sortJobsNewestFirst sorts by updatedAt descending", () => {
    const jobs = [
      { id: "a", updatedAt: "2026-01-01T00:00:00Z" },
      { id: "b", updatedAt: "2026-01-02T00:00:00Z" }
    ];
    const sorted = sortJobsNewestFirst(jobs);
    assert.equal(sorted[0].id, "b");
  });

  it("enrichJob adds kindLabel and timing", () => {
    const enriched = enrichJob({
      id: "j1",
      status: "completed",
      jobClass: "task",
      createdAt: new Date(Date.now() - 60000).toISOString(),
      completedAt: new Date().toISOString()
    });
    assert.equal(enriched.kindLabel, "rescue");
    assert.ok(enriched.duration);
  });

  // Audit M2 / task P1-2. A worker killed by OOM, `kill -9` or a reboot leaves
  // its job "running" forever; nothing checks whether the pid is alive, and the
  // stored pid is later handed to `taskkill /T /F`, which may by then belong to
  // an unrelated process.
  it(
    "enrichJob marks a running job whose worker is gone as stale",
    { todo: "P1-2: liveness check on enrichJob; identity check before terminateProcessTree" },
    () => {
      const gone = enrichJob({
        id: "j-stale",
        status: "running",
        jobClass: "task",
        pid: 999999999,
        startedAt: new Date(Date.now() - 60000).toISOString()
      });
      assert.equal(gone.phase, "stale");

      const alive = enrichJob({ id: "j-alive", status: "running", jobClass: "task", pid: process.pid, startedAt: new Date().toISOString() });
      assert.notEqual(alive.phase, "stale");

      // Paused jobs have no worker by design and must never look stale.
      const paused = enrichJob({ id: "j-paused", status: "awaiting-approval", jobClass: "task", pid: null });
      assert.equal(paused.phase, "awaiting-approval");
    }
  );

  it("resolveResultJob throws when no jobs exist", () => {
    assert.throws(() => resolveResultJob(tempDir, ""), /No finished/);
  });

  it("resolveCancelableJob throws when no active jobs", () => {
    assert.throws(() => resolveCancelableJob(tempDir, ""), /No active/);
  });
});
