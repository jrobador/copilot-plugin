#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
    buildPersistentTaskSessionId,
    buildTaskPayload,
    DEFAULT_CONTINUE_PROMPT,
    createSession,
    runPrompt,
    getCopilotAvailability,
    getCopilotLoginStatus,
    getSessionRuntimeStatus,
    listModels,
    parseStructuredOutput,
    READ_ONLY,
    resumeSession,
    shutdownClient,
    WORKSPACE_WRITE
  } from "./lib/copilot-client.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
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
import { isWideRoot } from "./lib/paths.mjs";
import {
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
// Matches the SDK's ReasoningEffort type exactly. The previous set
// (none, minimal, ...) was inherited from Codex: "minimal" passed our
// validation and then failed inside the SDK, while "max" -- which the SDK
// accepts -- was rejected here.
const VALID_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
// Convenience aliases. Real ids come from `client.listModels()`; these only
// spare the user from typing an exact version string.
const MODEL_ALIASES = new Map([
  ["codex", "gpt-5.3-codex"],
  ["gemini", "gemini-3.1-pro-preview"],
  ["sonnet", "claude-sonnet-5"],
  ["opus", "claude-opus-5"]
]);
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

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

function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: low, medium, high, xhigh, max.`
    );
  }
  return normalized;
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

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
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

/**
 * Both review prompts declare a JSON output contract. The schema file is the
 * single source of that contract, so inject it rather than describing it twice
 * (upstream referred to "the provided schema" but never provided it).
 */
function buildReviewPrompt(templateName, { reviewName, context, focusText }) {
  const template = loadPromptTemplate(ROOT_DIR, templateName);
  return interpolateTemplate(template, {
    REVIEW_KIND: reviewName,
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    OUTPUT_SCHEMA: fs.readFileSync(REVIEW_SCHEMA, "utf8").trim(),
    REVIEW_INPUT: context.content
  });
}

async function ensureCopilotReady(cwd) {
  const authStatus = await getCopilotLoginStatus(cwd);
  if (!authStatus.available) {
    throw new Error(
      "The Copilot runtime is unavailable. Install it with `npm install -g @github/copilot`, then rerun `/copilot:setup`."
    );
  }
  if (!authStatus.loggedIn) {
    throw new Error(
      `Copilot is not authenticated (${authStatus.detail}). Run \`!copilot login\`, then rerun \`/copilot:setup\`.`
    );
  }
  return authStatus;
}

/**
 * Fail early on a model this account cannot use.
 *
 * Without this the session starts, the turn runs, and the failure surfaces from
 * deep inside the SDK with no hint about which ids are valid. The account's own
 * model list is the answer, so show it.
 */
async function ensureModelAvailable(cwd, model) {
  if (!model) return;

  const models = await listModels(cwd);
  if (models.length === 0) return; // Could not enumerate; let the run decide.

  const ids = models.map((entry) => entry.id ?? entry.name).filter(Boolean);
  if (ids.includes(model)) return;

  throw new Error(
    [
      `Model "${model}" is not available on this account.`,
      `Available models: ${ids.join(", ")}.`,
      `Aliases: ${[...MODEL_ALIASES.keys()].join(", ")}.`
    ].join("\n")
  );
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

async function resolveLatestTrackedTaskSession(workspaceRoot, options = {}) {
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const activeTask = jobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /copilot:status before continuing it.`);
  }

  const trackedTask = jobs.find((job) => job.jobClass === "task" && job.status === "completed" && job.sessionId);
  if (trackedTask) {
    return { id: trackedTask.sessionId };
  }

  return null;
}

async function executeReviewRun(request) {
  await ensureCopilotReady(request.cwd);
  await ensureModelAvailable(request.cwd, request.model);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  const context = collectReviewContext(request.cwd, target);
  const isAdversarial = reviewName === "Adversarial Review";

  // Both reviews are structured. Upstream left the plain review as a one-line
  // prompt with no schema, which made its output impossible to render or sort
  // by severity the way the review commands promise.
  const isStructured = true;
  const prompt = buildReviewPrompt(isAdversarial ? "adversarial-review" : "review", {
    reviewName,
    context,
    focusText
  });

  const session = await createSession({
    cwd: context.repoRoot,
    workspaceRoot: context.repoRoot,
    model: request.model,
    reasoningEffort: request.effort,
    // A review never edits. This is enforced by the permission handler, not by
    // asking the model nicely.
    permissionMode: READ_ONLY,
    systemMessage: isAdversarial
      ? "You are Copilot performing an adversarial software review. Return your findings as JSON matching the provided schema."
      : "You are Copilot performing a code review. Return your findings as JSON matching the provided schema."
  });

  const result = await runPrompt(session, prompt, {
    onProgress: request.onProgress,
    // Attaching the repo root lets Copilot open the files around the diff
    // instead of reasoning only about the hunks pasted into the prompt.
    attachments: [{ type: "directory", path: context.repoRoot, displayName: "repository" }],
    agentMode: "plan"
  });
  const rawOutput = result.content ?? "";

  if (isStructured) {
    const parsed = parseStructuredOutput(rawOutput, {
      failureMessage: result.error?.message ?? ""
    });
    const payload = {
      review: reviewName,
      target,
      sessionId: result.sessionId,
      context: {
        repoRoot: context.repoRoot,
        branch: context.branch,
        summary: context.summary
      },
      copilot: {
        status: rawOutput ? 0 : 1,
        stdout: rawOutput,
        reasoning: result.reasoning
      },
      result: parsed.parsed,
      rawOutput: parsed.rawOutput,
      parseError: parsed.parseError,
      reasoningSummary: result.reasoning ? [result.reasoning] : [],
      // A review is read-only, so touchedFiles should stay empty; recording
      // both makes a violation visible instead of silently absorbed.
      touchedFiles: result.touchedFiles ?? [],
      denials: result.denials ?? []
    };
    return {
      exitStatus: rawOutput ? 0 : 1,
      sessionId: result.sessionId,
      payload,
      rendered: renderReviewResult(parsed, {
        reviewLabel: reviewName,
        targetLabel: context.target.label,
        reasoningSummary: result.reasoning ? [result.reasoning] : []
      }),
      summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(rawOutput, `${reviewName} finished.`),
      jobTitle: `Copilot ${reviewName}`,
      jobClass: "review",
      targetLabel: context.target.label
    };
  }

  // Plain review result
  const payload = {
    review: reviewName,
    target,
    sessionId: result.sessionId,
    copilot: {
      status: rawOutput ? 0 : 1,
      stdout: rawOutput,
      reasoning: result.reasoning
    }
  };
  return {
    exitStatus: rawOutput ? 0 : 1,
    sessionId: result.sessionId,
    payload,
    rendered: renderReviewResult(
      { parsed: null, parseError: null, rawOutput },
      { reviewLabel: reviewName, targetLabel: context.target.label, reasoningSummary: [] }
    ),
    summary: firstMeaningfulLine(rawOutput, `${reviewName} completed.`),
    jobTitle: `Copilot ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}

async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  await ensureCopilotReady(request.cwd);
  await ensureModelAvailable(request.cwd, request.model);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast
  });

  let sessionId = null;
  if (request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskSession(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw new Error("No previous Copilot task session was found for this repository.");
    }
    sessionId = latestThread.id;
  } else {
    sessionId = buildPersistentTaskSessionId(request.prompt || DEFAULT_CONTINUE_PROMPT);
  }

  if (!request.prompt && !request.resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  // `--write` decides whether Copilot may edit the tree. Upstream parsed the
  // flag, stored it on the job record, printed it in the report, and never
  // passed it to the session, so every task ran with blanket approval.
  const permissionMode = request.write ? WORKSPACE_WRITE : READ_ONLY;
  // The background worker re-reads the stored request, so the wide-root
  // refusal has to hold here too, not only where the flags were parsed.
  assertWriteRootAcceptable(request, workspaceRoot);
  const unsafeShell = request.unsafeShell === true;
  const extraPrograms = getConfig(workspaceRoot).extraPrograms ?? [];
  const sessionOptions = {
    cwd: request.cwd,
    workspaceRoot,
    model: request.model,
    reasoningEffort: request.effort,
    permissionMode,
    unsafeShell,
    extraPrograms
  };

  const { session, resumed } = request.resumeLast
    ? await resumeSession(sessionId, sessionOptions)
    : {
        session: await createSession({ ...sessionOptions, sessionId }),
        resumed: false
      };

  if (unsafeShell) {
    request.onProgress?.({
      message: "Shell tools are unfenced (--unsafe-shell).",
      phase: "starting",
      stderrMessage: "Shell: unfenced (--unsafe-shell)",
      logTitle: null,
      logBody: null
    });
  }

  if (request.resumeLast && !resumed) {
    request.onProgress?.({
      message: "Previous session could not be resumed; started a fresh one.",
      phase: "starting",
      stderrMessage: `Session ${sessionId} was not resumable; started fresh.`,
      logTitle: null,
      logBody: null
    });
  }

  const promptText = request.prompt || DEFAULT_CONTINUE_PROMPT;
  const result = await runPrompt(session, promptText, { onProgress: request.onProgress });
  const rawOutput = result.content ?? "";
  const failureMessage = "";

  const payload = buildTaskPayload(result, { sessionId, rawOutput, unsafeShell });
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage,
      reasoningSummary: payload.reasoningSummary
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write: Boolean(request.write),
      touchedFiles: payload.touchedFiles,
      denials: payload.denials,
      unsafeShell
    }
  );

  return {
    exitStatus: rawOutput ? 0 : 1,
    sessionId: result.sessionId ?? sessionId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write),
    unsafeShell
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Copilot Review" : `Copilot ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "Copilot Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    };
  }

  const title = resumeLast ? "Copilot Resume" : "Copilot Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
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

/**
 * A --write job whose root is the home directory or a drive root would be
 * allowed to edit everything the user owns. Refuse unless explicitly asked.
 */
function assertWriteRootAcceptable({ write, allowWideRoot }, workspaceRoot) {
  if (!write || allowWideRoot || !isWideRoot(workspaceRoot)) return;
  throw new Error(
    `Refused to run a --write task with workspace root ${workspaceRoot}: it is your home directory, an ancestor of it, or a filesystem root, so "inside the workspace" would mean everything. Run from a project directory, or pass --allow-wide-root if you really mean it.`
  );
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

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "copilot-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const child = spawnDetachedTaskWorker(cwd, job.id);
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: child.pid ?? null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

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

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
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
  const candidate =
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.sessionId &&
        job.status !== "queued" &&
        job.status !== "running" &&
        (!sessionId || job.sessionId === sessionId)
    ) ?? null;

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
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
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

async function main() {
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
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

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
