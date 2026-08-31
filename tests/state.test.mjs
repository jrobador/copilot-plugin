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
} from "../lib/state.mjs";

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

  it("never prunes a job that is still in play, even past 50", () => {
    const state = { version: 1, config: {}, jobs: [] };
    // One paused-for-approval job, made the OLDEST so a naive prune would drop it.
    state.jobs.push({
      id: "await-me",
      status: "awaiting-approval",
      updatedAt: new Date(Date.now() - 10_000_000).toISOString()
    });
    for (let i = 0; i < 60; i++) {
      state.jobs.push({ id: `done-${i}`, status: "completed", updatedAt: new Date(Date.now() - i * 1000).toISOString() });
    }
    const saved = saveState(tempDir, state);
    assert.ok(saved.jobs.some((j) => j.id === "await-me"), "awaiting-approval job must survive pruning");
    // queued and running are protected too.
    assert.ok(saved.jobs.length >= 50);
  });

  // A half-written or truncated state.json (three
  // detached workers and the hooks all wrote it with a plain writeFileSync)
  // parsed as "no state", and the next upsert persisted that emptiness: every
  // other job record was silently dropped from the index.
  it("does not wipe the job index when state.json is unreadable", () => {
    const survivor = { id: "survivor", status: "completed", title: "must survive", result: { rawOutput: "big" } };
    writeJobFile(tempDir, survivor.id, survivor);
    upsertJob(tempDir, { id: survivor.id, status: survivor.status, title: survivor.title });
    const stateFile = path.join(resolveStateDir(tempDir), "state.json");
    const raw = fs.readFileSync(stateFile, "utf8");
    fs.writeFileSync(stateFile, raw.slice(0, Math.floor(raw.length / 2)), "utf8");

    const recovered = loadState(tempDir);
    assert.equal(recovered.recovered, true);
    upsertJob(tempDir, { id: "newcomer", status: "queued" });

    const jobs = listJobs(tempDir);
    const ids = jobs.map((job) => job.id);
    assert.ok(ids.includes("newcomer"));
    assert.ok(ids.includes("survivor"), `survivor was dropped; index now has ${JSON.stringify(ids)}`);
    assert.ok(!("result" in jobs.find((job) => job.id === "survivor")), "the index does not carry job-file-only fields");
    assert.ok(
      fs.readdirSync(resolveStateDir(tempDir)).some((name) => name.startsWith("state.json.corrupt-")),
      "the unreadable file is quarantined, not overwritten"
    );
  });

  // The records hold prompts, diffs and model output.
  it("creates the state directory owner-only on POSIX", { skip: process.platform === "win32" }, () => {
    upsertJob(tempDir, { id: "perm-1", status: "completed" });
    const mode = fs.statSync(resolveStateDir(tempDir)).mode & 0o777;
    assert.equal(mode, 0o700);
  });

  it("writes state.json atomically (no temp file left behind, content complete)", () => {
    upsertJob(tempDir, { id: "atomic-1", status: "completed" });
    const dir = resolveStateDir(tempDir);
    assert.ok(!fs.readdirSync(dir).some((name) => name.includes(".tmp-")));
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")));
  });

  it("keeps queued and running jobs through a prune storm", () => {
    const state = { version: 1, config: {}, jobs: [] };
    state.jobs.push({ id: "queued-1", status: "queued", updatedAt: new Date(0).toISOString() });
    state.jobs.push({ id: "running-1", status: "running", updatedAt: new Date(1).toISOString() });
    for (let i = 0; i < 60; i++) {
      state.jobs.push({ id: `f-${i}`, status: "failed", updatedAt: new Date(Date.now() - i * 1000).toISOString() });
    }
    const saved = saveState(tempDir, state);
    assert.ok(saved.jobs.some((j) => j.id === "queued-1"));
    assert.ok(saved.jobs.some((j) => j.id === "running-1"));
  });
});
