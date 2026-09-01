#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { normalizeArgv, parseArgs } from "../lib/args.mjs";
import {
  getCopilotAvailability,
  getCopilotLoginStatus,
  getSdkStatus,
  getSessionRuntimeStatus,
  listModels,
  READ_ONLY,
  SDK_INSTALL_HINT,
  shutdownClient
} from "../lib/copilot-client.mjs";
import { readStdinIfPiped } from "../lib/fs.mjs";
import { resolveReviewTarget } from "../lib/git.mjs";
import { resolveAdditionalDirectories } from "../lib/paths.mjs";
import { WORKSPACE_EXECUTE } from "../lib/permissions.mjs";
import { binaryAvailable, runCommandChecked } from "../lib/process.mjs";
import { ROOT_DIR } from "../lib/plugin-root.mjs";
import {
  assertWriteRootAcceptable,
  buildTaskRunMetadata,
  COPILOT_AUTH,
  copilotSessionIdOf,
  dryRunReport,
  ensureCopilotReady,
  executeApprovalResume,
  executeReviewRun,
  executeTaskRun,
  isResumableTask,
  normalizeReasoningEffort,
  normalizeRequestedModel
} from "../lib/runs.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  setConfig,
  upsertJob,
  writeJobFile
} from "../lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  reapStaleJobs,
  resolveApprovableJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "../lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createPartialOutputWriter,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV,
  startWorkerWatchdog,
  terminateWorker
} from "../lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "../lib/workspace.mjs";
import {
  renderStoredJobResult,
  renderCancelReport,
  renderDryRun,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport
} from "../lib/render.mjs";

const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;

/**
 * Per-subcommand help, printed before anything is parsed or connected.
 *
 * `--help` used to fall through to the prompt: `task --help` created a session
 * and spent a real turn having the model answer the text "--help". Help must
 * never cost money.
 */
const COMMON_FLAGS = [
  "  -C, --cwd <dir>       Run against this directory instead of the current one.",
  "  --json                Machine-readable output.",
  "  --help                Print this and exit, without contacting Copilot."
];

const REVIEW_FLAGS = [
  "  --base <ref>          Review the branch diff against this ref.",
  "  --scope <auto|working-tree|branch>",
  "  --read-only           Narrow to git and rg; the default also runs the repository's toolchain.",
  "  --dry-run             Validate everything and print what would run. Costs nothing.",
  "  --model <model|alias> Model id, or one of: opus, sonnet, codex, gemini.",
  "  --effort <low|medium|high|xhigh|max>"
];

const COMMAND_HELP = {
  setup: [
    "Usage: copilot-plugin setup [--install-runtime] [--enable-review-gate|--disable-review-gate]",
    "                            [--allow-programs a,b,c|--clear-allowed-programs] [--json]",
    "",
    "Report the runtime, authentication and per-workspace settings.",
    "",
    "  --install-runtime     Install the Copilot SDK into the plugin directory.",
    "  --allow-programs      Extra programs run_command may spawn, in every mode.",
    ...COMMON_FLAGS
  ],
  review: [
    "Usage: copilot-plugin review [flags] [focus text]",
    "",
    "Review the working tree or the branch. Never writes; runs the repository's own",
    "commands to check its conclusions unless --read-only is given.",
    "",
    ...REVIEW_FLAGS,
    ...COMMON_FLAGS
  ],
  "adversarial-review": [
    "Usage: copilot-plugin adversarial-review [flags] [focus text]",
    "",
    "A review that attacks the design, not just the code.",
    "",
    ...REVIEW_FLAGS,
    ...COMMON_FLAGS
  ],
  task: [
    "Usage: copilot-plugin task [flags] [prompt]",
    "",
    "Hand a task to Copilot. Blocks until it finishes unless --background is given.",
    "Free text that starts with a dash goes after `--`.",
    "",
    "  --write               Let Copilot edit files. Off by default: it reports a diff.",
    "  --read-only           Force read-only even if --write is also present.",
    "  --add-dir <path>      Add a directory to this job's fence. Repeatable.",
    "  --dry-run             Validate root, add-dirs, prompt paths, model and PATH. Costs nothing.",
    "  --background          Run detached and return a job id.",
    "  --wait                Block until the job finishes. This is the default.",
    "  --resume-last         Continue the last Copilot thread for this repository.",
    "  --fresh               Start a new thread.",
    "  --unsafe-shell        Restore the runtime's own shell tools. Unfenced.",
    "  --allow-wide-root     Allow a --write job whose root is your home or a drive root.",
    "  --prompt-file <path>  Read the prompt from a file.",
    "  --model <model|alias> Model id, or one of: opus, sonnet, codex, gemini.",
    "  --effort <low|medium|high|xhigh|max>",
    ...COMMON_FLAGS
  ],
  status: [
    "Usage: copilot-plugin status [job-id] [--all] [--wait] [--json]",
    "",
    "  --all                 Every session's jobs for this workspace, not just this one's.",
    "  --wait                With a job id, block until that job leaves queued/running.",
    "  --timeout-ms <ms>     How long --wait waits. Default 240000.",
    ...COMMON_FLAGS
  ],
  result: ["Usage: copilot-plugin result [job-id] [--json]", "", "The stored output of a finished job.", "", ...COMMON_FLAGS],
  approve: ["Usage: copilot-plugin approve [job-id] [--json]", "", "Approve a job paused on a permission; it resumes in the background.", "", ...COMMON_FLAGS],
  deny: ["Usage: copilot-plugin deny [job-id] [--json]", "", "Deny a job paused on a permission; it closes without continuing.", "", ...COMMON_FLAGS],
  cancel: ["Usage: copilot-plugin cancel [job-id] [--json]", "", "Stop a running or paused job and its whole process tree.", "", ...COMMON_FLAGS]
};

function printCommandHelp(subcommand) {
  const help = COMMAND_HELP[subcommand];
  if (!help) {
    printUsage();
    return;
  }
  console.log(help.join("\n"));
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node bin/copilot-plugin.mjs setup [--install-runtime] [--enable-review-gate|--disable-review-gate] [--allow-programs a,b,c|--clear-allowed-programs] [--json]",
      "  node bin/copilot-plugin.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [--effort <level>]",
      "  node bin/copilot-plugin.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [--effort <level>] [focus text]",
      "  node bin/copilot-plugin.mjs task [--background|--wait] [--write|--read-only] [--dry-run] [--add-dir <path>]... [--unsafe-shell] [--allow-wide-root] [--resume-last|--resume|--fresh] [--model <model|alias>] [--effort <level>] [prompt]",
      "  node bin/copilot-plugin.mjs status [job-id] [--all] [--json]",
      "  node bin/copilot-plugin.mjs result [job-id] [--json]",
      "  node bin/copilot-plugin.mjs approve [job-id] [--json]",
      "  node bin/copilot-plugin.mjs deny [job-id] [--json]",
      "  node bin/copilot-plugin.mjs cancel [job-id] [--json]",
      "",
      "Any command: --help prints its flags without contacting Copilot."
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
  const sdkStatus = getSdkStatus();
  const copilotStatus = getCopilotAvailability(cwd);
  const authStatus = sdkStatus.available
    ? await getCopilotLoginStatus(cwd)
    : {
        available: false,
        loggedIn: false,
        detail: `${sdkStatus.detail}. ${SDK_INSTALL_HINT}`,
        authType: null,
        login: null,
        host: null
      };
  const config = getConfig(workspaceRoot);
  const models = authStatus.loggedIn ? await listModels(cwd) : [];

  const nextSteps = [];
  if (!sdkStatus.available) {
    // The one remediation. The SDK bundles the CLI, so there is nothing else
    // to install; pointing at a global CLI package here sent users the wrong way.
    nextSteps.push(SDK_INSTALL_HINT);
  } else if (!copilotStatus.available) {
    nextSteps.push("The runtime is installed but its CLI could not be found; reinstall with `/copilot:setup --install-runtime`.");
  }
  if (sdkStatus.available && copilotStatus.available && !authStatus.loggedIn) {
    nextSteps.push("Run `!copilot login`.");
    nextSteps.push(
      "If browser login is blocked, retry with `!copilot login --device-code` or `!copilot login --with-token`."
    );
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/copilot:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && sdkStatus.available && copilotStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    sdk: sdkStatus,
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
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate", "clear-allowed-programs", "install-runtime"]
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

  if (options["install-runtime"]) {
    const sdk = getSdkStatus();
    if (sdk.available) {
      actionsTaken.push(`The Copilot runtime is already installed (${sdk.detail}).`);
    } else {
      const { command, args, cwd: installDir } = sdk.installCommand;
      // npm's .cmd shim is the one thing allowed through cmd.exe; every
      // argument here is a constant, and the target is the plugin's own
      // directory via cwd.
      runCommandChecked(command, args, { cwd: installDir });
      const after = getSdkStatus();
      if (!after.available) {
        throw new Error(`npm finished but the runtime still does not resolve: ${after.detail}`);
      }
      actionsTaken.push(`Installed the Copilot runtime: ${after.detail}.`);
    }
  }

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
        ? `Allowed run_command to spawn ${programs.join(", ")} in every mode for ${workspaceRoot}.`
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

function createPluginJob({
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
  return createPluginJob({
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

function buildTaskRequest({ cwd, model, effort, prompt, write, unsafeShell, allowWideRoot, addDirs, resumeLast, jobId }) {
  return {
    cwd,
    model,
    effort,
    prompt,
    write,
    unsafeShell: Boolean(unsafeShell),
    allowWideRoot: Boolean(allowWideRoot),
    // Absolute already: the background worker resolves nothing.
    addDirs: Array.isArray(addDirs) ? addDirs : [],
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
  const scriptPath = path.join(ROOT_DIR, "bin", "copilot-plugin.mjs");
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
  // Close out anything whose worker died before adding one more.
  reapStaleJobs(cwd);
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
    booleanOptions: ["json", "background", "wait", "read-only", "dry-run"],
    aliasMap: {
      m: "model"
    }
  });

  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const permissionMode = options["read-only"] ? READ_ONLY : undefined;

  if (options["dry-run"]) {
    const report = await dryRunReport({
      cwd,
      workspaceRoot,
      prompt: focusText,
      model,
      permissionMode: permissionMode ?? WORKSPACE_EXECUTE,
      reviewName: config.reviewName,
      base: options.base,
      scope: options.scope
    });
    outputCommandResult(report, renderDryRun(report), options.json);
    if (!report.ready) process.exitCode = 1;
    return;
  }

  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createPluginJob({
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
        permissionMode,
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
    arrayOptions: ["add-dir"],
    booleanOptions: [
      "json",
      "write",
      "read-only",
      "unsafe-shell",
      "allow-wide-root",
      "resume-last",
      "resume",
      "fresh",
      "background",
      // Blocking is already the default; accepted so a caller that forwards it
      // gets a no-op instead of `--wait` silently becoming prompt text.
      "wait",
      "dry-run"
    ],
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
  // --read-only wins over --write: the safer reading of a contradiction.
  const write = Boolean(options.write) && !options["read-only"];

  if (options["dry-run"]) {
    const report = await dryRunReport({
      cwd,
      workspaceRoot,
      addDirs: options["add-dir"],
      prompt,
      model,
      write,
      allowWideRoot: Boolean(options["allow-wide-root"])
    });
    outputCommandResult(report, renderDryRun(report), options.json);
    if (!report.ready) process.exitCode = 1;
    return;
  }

  const flags = {
    unsafeShell: Boolean(options["unsafe-shell"]),
    allowWideRoot: Boolean(options["allow-wide-root"]),
    // Resolved here so a typo fails at the prompt instead of inside a
    // background worker nobody is watching.
    addDirs: resolveAdditionalDirectories(options["add-dir"], cwd)
  };
  assertWriteRootAcceptable({ write, allowWideRoot: flags.allowWideRoot }, workspaceRoot, flags.addDirs);
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
  // A detached worker has no parent to notice it: it watches its own record
  // and a lifetime cap instead. Without this, a cancelled or abandoned job
  // kept billing until its turn finished on its own.
  const stopWatchdog = startWorkerWatchdog(workspaceRoot, jobId, {
    onStop: (reason) => {
      appendLogLine(logFile, `Worker stopping itself (${reason}).`);
      shutdownClient()
        .catch(() => {})
        .finally(() => process.exit(1));
    }
  });
  try {
    await runTrackedJob(
      {
        ...storedJob,
        workspaceRoot,
        logFile
      },
      () =>
        executeTaskRun({
          ...request,
          onProgress: progress,
          // A detached worker's output was invisible until the turn ended.
          onPartial: createPartialOutputWriter(workspaceRoot, jobId)
        }),
      { logFile }
    );
  } finally {
    stopWatchdog();
  }
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  // A job whose worker is gone is closed here rather than reported as "stale"
  // forever: this is the one command a person runs while wondering about it.
  reapStaleJobs(cwd);
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
  const scriptPath = path.join(ROOT_DIR, "bin", "copilot-plugin.mjs");
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

  // A paused job has no worker; an active one is killed only if its pid still
  // belongs to a plugin process.
  const kill = job.pid ? terminateWorker(job.pid) : { attempted: false, delivered: false, reason: "no worker" };
  const killNote = kill.delivered
    ? `worker ${job.pid} terminated`
    : kill.attempted
      ? `worker ${job.pid} was already gone`
      : `worker not killed: ${kill.reason ?? "no worker"}`;
  appendLogLine(job.logFile, `Cancelled by user (${killNote}).`);

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

  // Before any parsing, state write or SDK load. `--` still marks the start of
  // free text, so `task -- --help` is a prompt, not a help request.
  const separator = argv.indexOf("--");
  const helpIndex = argv.findIndex((token) => token === "--help" || token === "-h");
  if (helpIndex !== -1 && (separator === -1 || helpIndex < separator)) {
    printCommandHelp(subcommand);
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
      // plugin process never exits and every slash command appears to hang.
      await shutdownClient().catch(() => {});
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      // Classified by code, set where the failure is known. Matching the text
      // turned "Unknown subcommand: authors" into an authentication failure.
      if (error?.code === COPILOT_AUTH) {
        process.stderr.write(`Copilot authentication failed: ${message}\nRun \`!copilot login\` to authenticate and retry.\n`);
      } else {
        process.stderr.write(`${message}\n`);
      }
      process.exitCode = 1;
    });
}
