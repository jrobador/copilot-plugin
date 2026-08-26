import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

import { createTempWorkspace, cleanupDir } from "./helpers.mjs";
import {
  resolveStateDir,
  loadState,
  saveState,
  upsertJob,
  listJobs,
  generateJobId,
  setConfig,
  getConfig,
  writeJobFile,
  readJobFile,
  resolveJobFile,
  resolveJobLogFile
} from "../plugins/copilot/scripts/lib/state.mjs";

describe("state", () => {
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

  it("resolveStateDir returns a path", () => {
    const dir = resolveStateDir(tempDir);
    assert.ok(dir);
    assert.ok(dir.includes("state"));
  });

  it("loadState returns default when no state file", () => {
    const state = loadState(tempDir);
    assert.equal(state.version, 1);
    assert.deepEqual(state.jobs, []);
    assert.equal(state.config.stopReviewGate, false);
  });

  it("generateJobId produces unique ids", () => {
    const a = generateJobId("task");
    const b = generateJobId("task");
    assert.notEqual(a, b);
    assert.ok(a.startsWith("task-"));
  });

  it("upsertJob creates and updates jobs", () => {
    const id = generateJobId("test");
    upsertJob(tempDir, { id, status: "queued", title: "Test Job" });
    const jobs = listJobs(tempDir);
    const found = jobs.find((j) => j.id === id);
    assert.ok(found);
    assert.equal(found.status, "queued");

    upsertJob(tempDir, { id, status: "running" });
    const updated = listJobs(tempDir).find((j) => j.id === id);
    assert.equal(updated.status, "running");
  });

  it("setConfig and getConfig work", () => {
    setConfig(tempDir, "stopReviewGate", true);
    const config = getConfig(tempDir);
    assert.equal(config.stopReviewGate, true);
    setConfig(tempDir, "stopReviewGate", false);
  });

  it("writeJobFile and readJobFile work", () => {
    const id = generateJobId("test");
    writeJobFile(tempDir, id, { id, result: "ok" });
    const jobFile = resolveJobFile(tempDir, id);
    const data = readJobFile(jobFile);
    assert.equal(data.result, "ok");
  });

  it("resolveJobLogFile returns a path", () => {
    const logFile = resolveJobLogFile(tempDir, "test-123");
    assert.ok(logFile.endsWith(".log"));
  });

  it("saveState prunes jobs beyond 50", () => {
    const state = loadState(tempDir);
    for (let i = 0; i < 55; i++) {
      state.jobs.push({ id: `prune-${i}`, updatedAt: new Date(Date.now() - i * 1000).toISOString() });
    }
    const saved = saveState(tempDir, state);
    assert.ok(saved.jobs.length <= 50);
  });
});
