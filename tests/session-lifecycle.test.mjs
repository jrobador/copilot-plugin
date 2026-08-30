import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { createTempWorkspace, cleanupDir } from "./helpers.mjs";
import { listJobs, upsertJob, writeJobFile } from "../plugins/copilot/scripts/lib/state.mjs";
import { cleanupSessionJobs } from "../plugins/copilot/scripts/session-lifecycle-hook.mjs";

// Audit L5 / task P2-5. SessionEnd used to delete every record of the session,
// results included, so /copilot:result after a restart found nothing, and a
// job paused for approval lost the context it needed to resume.
describe("SessionEnd cleanup", () => {
  let repo;
  let previousDataDir;

  before(() => {
    repo = createTempWorkspace();
    execSync("git init", { cwd: repo });
    fs.writeFileSync(path.join(repo, "f.txt"), "x\n");
    previousDataDir = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = path.join(repo, ".plugin-data");
  });

  after(() => {
    if (previousDataDir === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previousDataDir;
    cleanupDir(repo);
  });

  it("stops the session's active workers and keeps every record", () => {
    const seed = (id, status, extra = {}) => {
      const record = { id, status, jobClass: "task", sessionId: "sess-A", ...extra };
      writeJobFile(repo, id, record);
      upsertJob(repo, record);
    };
    seed("a-running", "running", { pid: 4242 });
    seed("a-queued", "queued", { pid: 4243 });
    seed("a-done", "completed", { copilotSessionId: "cs-1" });
    seed("a-paused", "awaiting-approval", { copilotSessionId: "cs-2", revive: { cwd: repo } });
    const other = { id: "b-running", status: "running", jobClass: "task", sessionId: "sess-B", pid: 9999 };
    writeJobFile(repo, other.id, other);
    upsertJob(repo, other);

    const killed = [];
    const outcome = cleanupSessionJobs(repo, "sess-A", { terminate: (pid) => killed.push(pid) });

    assert.deepEqual(outcome.stopped.sort(), ["a-queued", "a-running"]);
    assert.deepEqual(killed.sort(), [4242, 4243], "only this session's active workers are terminated");

    const byId = Object.fromEntries(listJobs(repo).map((job) => [job.id, job]));
    assert.equal(byId["a-running"].status, "cancelled");
    assert.equal(byId["a-queued"].status, "cancelled");
    assert.equal(byId["a-done"].status, "completed", "finished jobs keep their records");
    assert.equal(byId["a-paused"].status, "awaiting-approval", "paused jobs keep waiting");
    assert.equal(byId["b-running"].status, "running", "other sessions are untouched");
  });

  it("is a no-op without a session id or state", () => {
    assert.deepEqual(cleanupSessionJobs(repo, null), { stopped: [] });
    assert.deepEqual(cleanupSessionJobs(path.join(repo, "nowhere"), "sess-Z"), { stopped: [] });
  });
});
