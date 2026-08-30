#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
  getCopilotAvailability,
  getCopilotLoginStatus,
  getSessionRuntimeStatus,
  listModels,
  shutdownClient
} from "./lib/copilot-client.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { ROOT_DIR } from "./lib/plugin-root.mjs";
import {
  assertWriteRootAcceptable,
  buildTaskRunMetadata,
  copilotSessionIdOf,
  ensureCopilotReady,
  executeApprovalResume,
  executeReviewRun,
  executeTaskRun,
  isResumableTask,
  normalizeReasoningEffort,
  normalizeRequestedModel
} from "./lib/runs.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  setConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveApprovableJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport
} from "./lib/render.mjs";

const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/copilot-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--allow-programs a,b,c|--clear-allowed-programs] [--json]",
      "  node scripts/copilot-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [--effort <level>]",
      "  node scripts/copilot-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [--effort <level>] [focus text]",
      "  node scripts/copilot-companion.mjs task [--background] [--write] [--unsafe-shell] [--allow-wide-root] [--resume-last|--resume|--fresh] [--model <model|alias>] [--effort <low|medium|high|xhigh|max>] [prompt]",
      "  node scripts/copilot-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/copilot-companion.mjs result [job-id] [--json]",
      "  node scripts/copilot-companion.mjs approve [job-id] [--json]",
      "  node scripts/copilot-companion.mjs deny [job-id] [--json]",
      "  node scripts/copilot-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const copilotStatus = getCopilotAvailability(cwd);
  const authStatus = await getCopilotLoginStatus(cwd);
  const config = getConfig(workspaceRoot);
  const models = authStatus.loggedIn ? await listModels(cwd) : [];

  const nextSteps = [];
  if (!copilotStatus.available) {
    nextSteps.push("Install the Copilot CLI with `npm install -g @github/copilot`.");
  }
  if (copilotStatus.available && !authStatus.loggedIn) {
    nextSteps.push("Run `!copilot login`.");
    nextSteps.push(
      "If browser login is blocked, retry with `!copilot login --device-code` or `!copilot login --with-token`."
    );
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/copilot:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && copilotStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    copilot: copilotStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(),
    models: models.map((model) => model.id ?? model.name).filter(Boolean),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    extraPrograms: Array.isArray(config.extraPrograms) ? config.extraPrograms : [],
    actionsTaken,
    nextSteps
  };
}

/** `--allow-programs a,b,c` → validated, lowercase, deduped program names. */
function parseAllowedPrograms(raw) {
  const names = String(raw ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  for (const name of names) {
    if (!/^[a-z0-9._+-]+$/.test(name)) {
      throw new Error(`Invalid program name "${name}": use bare names like bun or pytest, not paths.`);
    }
  }
  return [...new Set(names)];
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "allow-programs"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate", "clear-allowed-programs"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }
  if (options["allow-programs"] !== undefined && options["clear-allowed-programs"]) {
    throw new Error("Choose either --allow-programs or --clear-allowed-programs.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  if (options["allow-programs"] !== undefined) {
    const programs = parseAllowedPrograms(options["allow-programs"]);
    setConfig(workspaceRoot, "extraPrograms", programs);
    actionsTaken.push(
      programs.length > 0
        ? `Allowed run_command to spawn ${programs.join(", ")} in --write jobs for ${workspaceRoot}.`
        : `Cleared the extra run_command programs for ${workspaceRoot}.`
    );
  } else if (options["clear-allowed-programs"]) {
    setConfig(workspaceRoot, "extraPrograms", []);
    actionsTaken.push(`Cleared the extra run_command programs for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Copilot Review" : `Copilot ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /copilot:status ${payload.jobId} for progress.\n`;
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({
  prefix,
  kind,
  title,
  workspaceRoot,
  jobClass,
  summary,
  write = false,
  unsafeShell = false,
  allowWideRoot = false
}) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write,
    unsafeShell,
    allowWideRoot
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write, flags = {}) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write,
    unsafeShell: Boolean(flags.unsafeShell),
    allowWideRoot: Boolean(flags.allowWideRoot)
  });
}

function buildTaskRequest({ cwd, model, effort, prompt, write, unsafeShell, allowWideRoot, resumeLast, jobId }) {
  return {
    cwd,
    model,
    effort,
    prompt,
    write,
    unsafeShell: Boolean(unsafeShell),
    allowWideRoot: Boolean(allowWideRoot),
    resumeLast,
    jobId
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId, spawnImpl = spawn) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "copilot-companion.mjs");
  const child = spawnImpl(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

/** @param {{spawnImpl?: typeof spawn}} [seams]  Test seam for the detached worker. */
export function enqueueBackgroundTask(cwd, job, request, seams = {}) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  // The worker reads this record as its first act, so it has to exist before
  // the worker does; spawning first left a fast worker with nothing to read
  // and a job that stayed "queued" forever. The pid is patched into the index
  // once the spawn returns. The job file is not rewritten afterwards: the
  // worker may already have replaced it with its "running" record.
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  const child = spawnDetachedTaskWorker(cwd, job.id, seams.spawnImpl);
  upsertJob(job.workspaceRoot, { id: job.id, pid: child.pid ?? null });

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile
    },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "effort", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model,
        effort,
        focusText,
        reviewName: config.reviewName,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review"
  });
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file"],
    booleanOptions: ["json", "write", "unsafe-shell", "allow-wide-root", "resume-last", "resume", "fresh", "background"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const write = Boolean(options.write);
  const flags = {
    unsafeShell: Boolean(options["unsafe-shell"]),
    allowWideRoot: Boolean(options["allow-wide-root"])
  };
  assertWriteRootAcceptable({ write, allowWideRoot: flags.allowWideRoot }, workspaceRoot);
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast
  });

  if (options.background) {
    await ensureCopilotReady(cwd);
    requireTaskRequest(prompt, resumeLast);

    const job = buildTaskJob(workspaceRoot, taskMetadata, write, flags);
    const request = buildTaskRequest({
      cwd,
      model,
      effort,
      prompt,
      write,
      ...flags,
      resumeLast,
      jobId: job.id
    });
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write, flags);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        effort,
        prompt,
        write,
        ...flags,
        resumeLast,
        jobId: job.id,
        onProgress: progress
      }),
    { json: options.json }
  );
}

/**
 * A detached worker has no stdout anyone reads. Whatever stops it before
 * runTrackedJob takes over has to land on the job record, or the job stays
 * "queued" forever with nothing to explain why.
 */
function markWorkerFailure(workspaceRoot, jobId, errorMessage, storedJob = null) {
  const completedAt = nowIso();
  const patch = { id: jobId, status: "failed", phase: "failed", pid: null, errorMessage, completedAt };
  try {
    writeJobFile(workspaceRoot, jobId, { ...(storedJob ?? {}), ...patch });
    upsertJob(workspaceRoot, patch);
  } catch {
    // Best effort: the error is rethrown by the caller either way.
  }
}

export async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  const jobId = options["job-id"];
  if (!jobId) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, jobId);
  if (!storedJob) {
    const message = `No stored job found for ${jobId}.`;
    markWorkerFailure(workspaceRoot, jobId, message);
    throw new Error(message);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    const message = `Stored job ${jobId} is missing its task request payload.`;
    markWorkerFailure(workspaceRoot, jobId, message, storedJob);
    throw new Error(message);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    () =>
      executeTaskRun({
        ...request,
        onProgress: progress
      }),
    { logFile }
  );
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = process.env[SESSION_ID_ENV] ?? null;
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  // Only a finished task with a known Copilot session can be continued; a
  // paused one is picked up with /copilot:approve, not --resume.
  const candidate = jobs.find((job) => isResumableTask(job) && (!sessionId || job.sessionId === sessionId)) ?? null;

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            sessionId: candidate.sessionId,
            copilotSessionId: copilotSessionIdOf(candidate),
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

function spawnDetachedApproveWorker(cwd, jobId, spawnImpl = spawn) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "copilot-companion.mjs");
  const child = spawnImpl(process.execPath, [scriptPath, "approve-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

/** @param {{spawnImpl?: typeof spawn}} [seams]  Test seam for the detached worker. */
export async function handleApprove(argv, seams = {}) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveApprovableJob(cwd, reference);

  if (!job.copilotSessionId || !job.revive) {
    throw new Error(`Job ${job.id} cannot be resumed: it is missing the Copilot session to revive.`);
  }

  // Re-arm the job as queued, then hand it to a detached worker that resumes
  // the session, allows the approved path, and re-instructs the model. The
  // record is written first for the same reason as in enqueueBackgroundTask.
  appendLogLine(job.logFile, `Approved by owner: ${job.pendingApproval?.request ?? "request"}.`);
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const approvedAt = nowIso();
  const queuedRecord = {
    ...existing,
    ...job,
    status: "queued",
    phase: "queued",
    pid: null,
    approvedAt
  };
  writeJobFile(workspaceRoot, job.id, queuedRecord);
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "queued",
    phase: "queued",
    pid: null,
    approvedAt
  });

  const child = spawnDetachedApproveWorker(cwd, job.id, seams.spawnImpl);
  upsertJob(workspaceRoot, { id: job.id, pid: child.pid ?? null });

  const payload = { jobId: job.id, status: "resuming", title: job.title };
  outputCommandResult(
    payload,
    `Approved. ${job.title} is resuming as ${job.id}. Check /copilot:status ${job.id} for progress.\n`,
    options.json
  );
}

export async function handleApproveWorker(argv) {
  const { options } = parseCommandInput(argv, { valueOptions: ["cwd", "job-id"] });
  const jobId = options["job-id"];
  if (!jobId) {
    throw new Error("Missing required --job-id for approve-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, jobId);
  if (!storedJob) {
    const message = `No stored job found for ${jobId}.`;
    markWorkerFailure(workspaceRoot, jobId, message);
    throw new Error(message);
  }
  if (!storedJob.revive || !storedJob.copilotSessionId) {
    const message = `Stored job ${jobId} has no revive context.`;
    markWorkerFailure(workspaceRoot, jobId, message, storedJob);
    throw new Error(message);
  }

  const { logFile, progress } = createTrackedProgress(
    { ...storedJob, workspaceRoot },
    { logFile: storedJob.logFile ?? null }
  );
  await runTrackedJob(
    { ...storedJob, workspaceRoot, logFile },
    () =>
      executeApprovalResume({
        ...storedJob.revive,
        copilotSessionId: storedJob.copilotSessionId,
        pendingApproval: storedJob.pendingApproval,
        title: storedJob.title,
        jobId: storedJob.id,
        onProgress: progress
      }),
    { logFile }
  );
}

async function handleDeny(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveApprovableJob(cwd, reference);
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};

  appendLogLine(job.logFile, `Denied by owner: ${job.pendingApproval?.request ?? "request"}.`);
  const completedAt = nowIso();
  const nextJob = {
    ...existing,
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    cancelledAt: completedAt,
    errorMessage: `Denied by owner: ${job.pendingApproval?.request ?? "request"}.`
  };
  writeJobFile(workspaceRoot, job.id, nextJob);
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: nextJob.errorMessage
  });

  const payload = { jobId: job.id, status: "denied", title: job.title };
  outputCommandResult(
    payload,
    `Denied ${job.pendingApproval?.request ?? "the request"}. Job ${job.id} is closed.\n`,
    options.json
  );
}

export async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference);
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};

  terminateProcessTree(job.pid ?? Number.NaN);
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

export async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    case "approve":
      await handleApprove(argv);
      break;
    case "approve-worker":
      await handleApproveWorker(argv);
      break;
    case "deny":
      await handleDeny(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

// Only run as a CLI when executed directly; tests import the handlers above.
const isEntrypoint =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isEntrypoint) {
  main()
    .finally(async () => {
      // The SDK keeps a Copilot CLI child process alive; without this the
      // companion process never exits and every slash command appears to hang.
      await shutdownClient().catch(() => {});
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      const isAuthError =
        /auth|login|unauthenticated|unauthorized|not signed in|credentials/i.test(message);
      if (isAuthError) {
        process.stderr.write(
          "Copilot authentication failed. Run `!copilot login` to authenticate and retry.\n"
        );
      } else {
        process.stderr.write(`${message}\n`);
      }
      process.exitCode = 1;
    });
}
