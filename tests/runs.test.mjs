import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createTempWorkspace, cleanupDir } from "./helpers.mjs";
import { scriptFakeSessions } from "./fake-copilot-fixture.mjs";
import { ensureClient, SDK_MODULE_ENV, shutdownClient } from "../plugins/copilot/scripts/lib/copilot-client.mjs";
import { getRepoRoot } from "../plugins/copilot/scripts/lib/git.mjs";
import { readStoredJob } from "../plugins/copilot/scripts/lib/job-control.mjs";
import { SHELL_TOOL_NAMES } from "../plugins/copilot/scripts/lib/run-command.mjs";
import { executeApprovalResume, executeReviewRun, executeTaskRun } from "../plugins/copilot/scripts/lib/runs.mjs";
import {
  AWAITING_APPROVAL,
  listJobs,
  readJobFile,
  resolveJobFile,
  upsertJob,
  writeJobFile
} from "../plugins/copilot/scripts/lib/state.mjs";
import { createJobRecord, runTrackedJob, SESSION_ID_ENV } from "../plugins/copilot/scripts/lib/tracked-jobs.mjs";
import {
  enqueueBackgroundTask,
  handleApprove,
  handleApproveWorker,
  handleCancel,
  handleTaskWorker
} from "../plugins/copilot/scripts/copilot-companion.mjs";

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fake-copilot-fixture.mjs");
const CLAUDE_SESSION = "claude-session-for-runs-test";

/**
 * The orchestration behind review, task, approve and cancel, run end to end
 * against the fake SDK: real git repo, real state files, real permission
 * policy, fake Copilot.
 */
describe("runs: review / task / approve flows against the fake SDK", () => {
  let tempDir;
  let repoRoot;
  const savedEnv = {};

  function taskJob(id) {
    return createJobRecord({
      id,
      kind: "task",
      kindLabel: "rescue",
      jobClass: "task",
      title: "Copilot Task",
      workspaceRoot: tempDir,
      summary: id,
      write: false
    });
  }

  before(() => {
    tempDir = createTempWorkspace();
    execSync("git init", { cwd: tempDir });
    execSync("git config user.email test@test.com", { cwd: tempDir });
    execSync("git config user.name Test", { cwd: tempDir });
    fs.writeFileSync(path.join(tempDir, "tracked.txt"), "hello\n");
    execSync("git add . && git commit -m init", { cwd: tempDir });
    repoRoot = getRepoRoot(tempDir);

    for (const key of ["CLAUDE_PLUGIN_DATA", SDK_MODULE_ENV, SESSION_ID_ENV]) {
      savedEnv[key] = process.env[key];
    }
    process.env.CLAUDE_PLUGIN_DATA = path.join(tempDir, ".plugin-data");
    process.env[SDK_MODULE_ENV] = FIXTURE;
    process.env[SESSION_ID_ENV] = CLAUDE_SESSION;
  });

  after(async () => {
    await shutdownClient();
    scriptFakeSessions({});
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    cleanupDir(tempDir);
  });

  it("review: read-only session, repo attached, schema and diff in the prompt", async () => {
    scriptFakeSessions({
      _cannedResponse: {
        data: { content: '{"verdict":"approve","summary":"Fine as is.","findings":[],"next_steps":[]}' }
      }
    });
    fs.writeFileSync(path.join(tempDir, "change.txt"), "a brand new line of code\n");

    const execution = await executeReviewRun({ cwd: tempDir, reviewName: "Review" });

    assert.equal(execution.exitStatus, 0);
    assert.equal(execution.jobClass, "review");
    assert.match(execution.rendered, /Verdict: approve/);
    assert.equal(execution.payload.result.verdict, "approve");

    const client = await ensureClient(repoRoot);
    const session = client.sessions.at(-1);
    const message = session.messages[0];
    assert.equal(message.agentMode, "plan");
    assert.equal(message.attachments[0].type, "directory");
    assert.match(message.prompt, /"\$schema"/, "the output schema is injected");
    assert.match(message.prompt, /a brand new line of code/, "the working-tree diff is in the prompt");
    assert.ok(SHELL_TOOL_NAMES.every((name) => session.config.excludedTools.includes(name)));
    assert.ok(session.config.tools.some((tool) => tool.name === "run_command"));
    // Read-only is enforced by the handler bound to the session, not by the prompt.
    assert.equal(session.config.onPermissionRequest({ kind: "write", fileName: "change.txt" }).kind, "reject");
    assert.equal(session.config.onPermissionRequest({ kind: "read", path: "change.txt" }).kind, "approve-once");
    fs.unlinkSync(path.join(tempDir, "change.txt"));
  });

  let firstTaskSessionId;

  it("task: runs the prompt and stores a completed job", async () => {
    scriptFakeSessions({ _cannedResponse: { data: { content: "Task done." } } });
    const job = taskJob("task-flow-1");

    const execution = await runTrackedJob(job, () =>
      executeTaskRun({ cwd: tempDir, prompt: "investigate the thing", write: false, jobId: job.id })
    );

    assert.equal(execution.exitStatus, 0);
    assert.equal(execution.payload.rawOutput, "Task done.");
    assert.ok(execution.sessionId.startsWith("copilot-companion-task"));
    firstTaskSessionId = execution.sessionId;

    const stored = readStoredJob(tempDir, job.id);
    assert.equal(stored.status, "completed");
    assert.equal(stored.sessionId, CLAUDE_SESSION, "the Claude session id is recorded on the job");
    assert.equal(listJobs(tempDir).find((entry) => entry.id === job.id).status, "completed");
  });

  // Audit H3 / task P0-3. The previous task's *Claude* session id used to be
  // handed to resumeSession as if it were the Copilot session id, so the
  // resume always failed and a fresh session started under Claude's id.
  it("--resume-last resumes the Copilot session of the previous task", async () => {
    scriptFakeSessions({ _cannedResponse: { data: { content: "Continued." } } });
    const client = await ensureClient(tempDir);
    const before = client.calls.length;
    const progress = [];

    const execution = await executeTaskRun({
      cwd: tempDir,
      prompt: "continue",
      resumeLast: true,
      write: false,
      jobId: "task-flow-2",
      onProgress: (event) => progress.push(event.message)
    });

    const resumeCall = client.calls.slice(before).find((call) => call.call === "resumeSession");
    assert.ok(resumeCall, "resumeSession was not called");
    assert.equal(resumeCall.sessionId, firstTaskSessionId);
    assert.equal(execution.sessionId, firstTaskSessionId);
    assert.equal(execution.copilotSessionId, firstTaskSessionId);
    assert.ok(progress.some((message) => message.includes(`Resumed Copilot session ${firstTaskSessionId}`)), JSON.stringify(progress));
    const stored = readStoredJob(tempDir, "task-flow-1");
    assert.equal(stored.copilotSessionId, firstTaskSessionId);
    assert.equal(stored.threadId, firstTaskSessionId, "the renderers read threadId");
  });

  it("--resume-last falls back to a fresh session with a new id when the old one is gone", async () => {
    scriptFakeSessions({ _cannedResponse: { data: { content: "Started over." } } });
    // Pretend the CLI pruned the session the last completed task points at.
    const client = await ensureClient(tempDir);
    client.knownSessions.clear();
    const progress = [];

    const execution = await executeTaskRun({
      cwd: tempDir,
      prompt: "continue",
      resumeLast: true,
      write: false,
      jobId: "task-flow-3",
      onProgress: (event) => progress.push(event.message)
    });

    assert.notEqual(execution.copilotSessionId, firstTaskSessionId, "the fresh session must not reuse the stale id");
    assert.ok(progress.some((message) => /could not be resumed; started a fresh one/.test(message)), JSON.stringify(progress));
  });

  let escalatedJobId;

  it("task: a flagged read pauses the job as awaiting-approval with its revive context", async () => {
    scriptFakeSessions({
      _permissionRequests: [{ kind: "read", path: "ESCALATE_ME.txt" }],
      _cannedResponse: { data: { content: "I need to read that file first." } }
    });
    const job = taskJob("task-esc-1");

    const execution = await runTrackedJob(job, () =>
      executeTaskRun({ cwd: tempDir, prompt: "read the secret", write: false, jobId: job.id })
    );

    assert.equal(execution.escalated, true);
    const stored = readStoredJob(tempDir, job.id);
    assert.equal(stored.status, AWAITING_APPROVAL);
    assert.equal(stored.copilotSessionId, execution.sessionId);
    assert.equal(stored.pendingApproval.file, "ESCALATE_ME.txt");
    // model/effort are undefined here and drop out of the JSON; the rest must survive.
    for (const key of ["cwd", "workspaceRoot", "write", "unsafeShell"]) {
      assert.ok(key in stored.revive, `revive.${key} is missing`);
    }
    escalatedJobId = job.id;
  });

  it("approve: resumes the same Copilot session with the read allowed", async () => {
    scriptFakeSessions({
      _permissionRequests: [{ kind: "read", path: "ESCALATE_ME.txt" }],
      _cannedResponse: { data: { content: "Read it. Done." } }
    });
    const stored = readStoredJob(tempDir, escalatedJobId);

    const execution = await runTrackedJob({ ...stored, workspaceRoot: tempDir }, () =>
      executeApprovalResume({
        ...stored.revive,
        copilotSessionId: stored.copilotSessionId,
        pendingApproval: stored.pendingApproval,
        title: stored.title,
        jobId: stored.id
      })
    );

    assert.ok(!execution.escalated);
    assert.equal(execution.exitStatus, 0);
    const client = await ensureClient(tempDir);
    const session = client.sessions.at(-1);
    assert.equal(session.resumed, true);
    assert.equal(session.sessionId, stored.copilotSessionId);
    assert.match(String(session.messages[0]), /approved/);
    assert.equal(session.permissionDecisions[0].decision.kind, "approve-once", "the approved path is allowed on resume");
    assert.equal(readStoredJob(tempDir, escalatedJobId).status, "completed");
  });

  it("approve: a pruned Copilot session expires the job instead of restarting it", async () => {
    const job = { ...taskJob("task-exp-1"), status: AWAITING_APPROVAL, copilotSessionId: "session-pruned-away" };
    const execution = await runTrackedJob(job, () =>
      executeApprovalResume({
        cwd: tempDir,
        workspaceRoot: tempDir,
        write: false,
        copilotSessionId: "session-pruned-away",
        pendingApproval: { file: "ESCALATE_ME.txt", request: "read: ESCALATE_ME.txt" },
        jobId: job.id
      })
    );
    assert.equal(execution.expired, true);
    assert.equal(readStoredJob(tempDir, job.id).status, "expired");
  });

  // Audit M1 / task P0-5. The detached worker used to be spawned before its
  // job file was written; a fast worker found nothing and died silently,
  // leaving the job "queued" forever.
  it("enqueue: the job file exists before the task worker is spawned", () => {
      const job = taskJob("task-bg-1");
      let seenAtSpawn = null;
      const spawnImpl = (_file, args) => {
        const id = args[args.indexOf("--job-id") + 1];
        seenAtSpawn = fs.existsSync(resolveJobFile(tempDir, id));
        return { pid: 4242, unref() {} };
      };

      const { payload } = enqueueBackgroundTask(tempDir, job, { cwd: tempDir, prompt: "bg", write: false, jobId: job.id }, { spawnImpl });

      assert.equal(payload.status, "queued");
      assert.equal(seenAtSpawn, true, "job file must exist before the worker is spawned");
      assert.equal(listJobs(tempDir).find((entry) => entry.id === job.id).pid, 4242, "the pid is recorded in the index");
      assert.equal(readStoredJob(tempDir, job.id).request.prompt, "bg");
  });

  it("worker: a job it cannot read or use is marked failed instead of staying queued", async () => {
    await assert.rejects(() => handleTaskWorker(["--cwd", tempDir, "--job-id", "task-missing"]), /No stored job found/);
    assert.equal(listJobs(tempDir).find((entry) => entry.id === "task-missing").status, "failed");

    const noRequest = { ...taskJob("task-no-request"), status: "queued" };
    writeJobFile(tempDir, noRequest.id, noRequest);
    upsertJob(tempDir, noRequest);
    await assert.rejects(() => handleTaskWorker(["--cwd", tempDir, "--job-id", noRequest.id]), /missing its task request/);
    assert.equal(readStoredJob(tempDir, noRequest.id).status, "failed");
    assert.match(readStoredJob(tempDir, noRequest.id).errorMessage, /missing its task request/);

    const noRevive = { ...taskJob("task-no-revive"), status: "queued", copilotSessionId: "x" };
    writeJobFile(tempDir, noRevive.id, noRevive);
    upsertJob(tempDir, noRevive);
    await assert.rejects(() => handleApproveWorker(["--cwd", tempDir, "--job-id", noRevive.id]), /no revive context/);
    assert.equal(listJobs(tempDir).find((entry) => entry.id === noRevive.id).status, "failed");
  });

  it("approve: the job is re-armed as queued before the approve worker is spawned", async () => {
      const id = "task-appr-1";
      const record = {
        ...taskJob(id),
        status: AWAITING_APPROVAL,
        copilotSessionId: "sess-appr",
        revive: { cwd: tempDir, workspaceRoot: tempDir, write: false },
        pendingApproval: { file: "ESCALATE_ME.txt", request: "read: ESCALATE_ME.txt" }
      };
      writeJobFile(tempDir, id, record);
      upsertJob(tempDir, record);
      let recordAtSpawn = null;
      const spawnImpl = () => {
        recordAtSpawn = readJobFile(resolveJobFile(tempDir, id));
        return { pid: 4243, unref() {} };
      };

      await handleApprove([id, "--cwd", tempDir, "--json"], { spawnImpl });

      assert.equal(readStoredJob(tempDir, id).status, "queued");
      assert.equal(recordAtSpawn.status, "queued", "the job must be re-armed before the worker is spawned");
      assert.equal(recordAtSpawn.copilotSessionId, "sess-appr", "the revive context survives the re-arm");
      assert.equal(listJobs(tempDir).find((entry) => entry.id === id).pid, 4243);
  });

  it("cancel: closes a queued job and a paused job without a live worker", async () => {
    for (const [id, status] of [
      ["task-cancel-1", "queued"],
      ["task-cancel-2", AWAITING_APPROVAL]
    ]) {
      const record = { ...taskJob(id), status, pid: status === "queued" ? 999999999 : null };
      writeJobFile(tempDir, id, record);
      upsertJob(tempDir, record);

      await handleCancel([id, "--cwd", tempDir, "--json"]);

      assert.equal(readStoredJob(tempDir, id).status, "cancelled", id);
      assert.equal(listJobs(tempDir).find((entry) => entry.id === id).status, "cancelled", id);
    }
  });
});
