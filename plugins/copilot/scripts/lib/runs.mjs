/**
 * The orchestration behind the companion's subcommands: a review run, a task
 * run, and the resume of a task that paused on the owner's approval.
 *
 * Lifted out of copilot-companion.mjs unchanged so the flows can run in tests
 * against the fake SDK (see COPILOT_COMPANION_SDK_MODULE). The companion keeps
 * the argv parsing, job bookkeeping and output; this module keeps the part
 * that talks to Copilot.
 */

import fs from "node:fs";

import {
  buildPersistentTaskSessionId,
  buildTaskPayload,
  DEFAULT_CONTINUE_PROMPT,
  createSession,
  runPrompt,
  getCopilotLoginStatus,
  listModels,
  parseStructuredOutput,
  READ_ONLY,
  resumeSession,
  WORKSPACE_WRITE
} from "./copilot-client.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./git.mjs";
import { sortJobsNewestFirst } from "./job-control.mjs";
import { isWideRoot } from "./paths.mjs";
import { makeSentinelEscalation } from "./permissions.mjs";
import { REVIEW_SCHEMA, ROOT_DIR } from "./plugin-root.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./prompts.mjs";
import { renderReviewResult, renderTaskResult } from "./render.mjs";
import { getConfig, listJobs } from "./state.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

// Matches the SDK's ReasoningEffort type exactly. The previous set
// (none, minimal, ...) was inherited from Codex: "minimal" passed our
// validation and then failed inside the SDK, while "max" -- which the SDK
// accepts -- was rejected here.
export const VALID_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
// Convenience aliases. Real ids come from `client.listModels()`; these only
// spare the user from typing an exact version string.
export const MODEL_ALIASES = new Map([
  ["codex", "gpt-5.3-codex"],
  ["gemini", "gemini-3.1-pro-preview"],
  ["sonnet", "claude-sonnet-5"],
  ["opus", "claude-opus-5"]
]);
export const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

export function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

export function normalizeReasoningEffort(effort) {
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

/**
 * Both review prompts declare a JSON output contract. The schema file is the
 * single source of that contract, so inject it rather than describing it twice
 * (upstream referred to "the provided schema" but never provided it).
 */
export function buildReviewPrompt(templateName, { reviewName, context, focusText }) {
  const template = loadPromptTemplate(ROOT_DIR, templateName);
  return interpolateTemplate(template, {
    REVIEW_KIND: reviewName,
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    OUTPUT_SCHEMA: fs.readFileSync(REVIEW_SCHEMA, "utf8").trim(),
    REVIEW_INPUT: context.content
  });
}

export async function ensureCopilotReady(cwd) {
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
export async function ensureModelAvailable(cwd, model) {
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

/**
 * The Copilot session id of a job, whichever name it was stored under.
 * `sessionId` is deliberately not consulted: that is the Claude Code session.
 */
export function copilotSessionIdOf(job) {
  return job?.copilotSessionId ?? job?.threadId ?? null;
}

/** Is this a finished task whose Copilot session a follow-up can pick up? */
export function isResumableTask(job) {
  return job?.jobClass === "task" && job.status === "completed" && Boolean(copilotSessionIdOf(job));
}

export async function resolveLatestTrackedTaskSession(workspaceRoot, options = {}) {
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const activeTask = jobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /copilot:status before continuing it.`);
  }

  const trackedTask = jobs.find(isResumableTask);
  if (trackedTask) {
    return { id: copilotSessionIdOf(trackedTask), jobId: trackedTask.id };
  }

  return null;
}

export async function executeReviewRun(request) {
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
      copilotSessionId: result.sessionId ?? null,
      threadId: result.sessionId ?? null,
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
    copilotSessionId: result.sessionId ?? null,
    threadId: result.sessionId ?? null,
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

export async function executeTaskRun(request) {
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
    extraPrograms,
    // Reads flagged for the owner pause the job (v1: a sentinel filename). Reads
    // the owner already approved in a prior escalation pass straight through.
    escalateReads: makeSentinelEscalation(),
    approvedReads: new Set(Array.isArray(request.approvedReads) ? request.approvedReads : [])
  };

  const { session, resumed } = request.resumeLast
    ? await resumeSession(sessionId, sessionOptions)
    : {
        session: await createSession({ ...sessionOptions, sessionId }),
        resumed: false
      };
  // Whatever session we actually ended up on: the requested one, or the fresh
  // one resumeSession fell back to.
  const activeSessionId = session?.sessionId ?? sessionId;

  if (unsafeShell) {
    request.onProgress?.({
      message: "Shell tools are unfenced (--unsafe-shell).",
      phase: "starting",
      stderrMessage: "Shell: unfenced (--unsafe-shell)",
      logTitle: null,
      logBody: null
    });
  }

  if (request.resumeLast) {
    request.onProgress?.({
      message: resumed
        ? `Resumed Copilot session ${activeSessionId}.`
        : `Previous session ${sessionId} could not be resumed; started a fresh one (${activeSessionId}).`,
      phase: "starting",
      stderrMessage: resumed
        ? `Resumed session ${activeSessionId}`
        : `Session ${sessionId} was not resumable; started fresh as ${activeSessionId}.`,
      logTitle: null,
      logBody: null
    });
  }

  const promptText = request.prompt || DEFAULT_CONTINUE_PROMPT;
  const result = await runPrompt(session, promptText, { onProgress: request.onProgress });
  const rawOutput = result.content ?? "";
  const failureMessage = "";

  // The policy paused a request for the owner. Hand back an escalated result so
  // the job is stored as awaiting-approval instead of completed, with enough to
  // revive it: the Copilot session id and the fields needed to resume.
  if (result.escalated) {
    const copilotSessionId = result.sessionId ?? activeSessionId;
    return {
      escalated: true,
      exitStatus: 0,
      sessionId: copilotSessionId,
      copilotSessionId,
      threadId: copilotSessionId,
      pendingApproval: result.pendingApproval,
      revive: {
        cwd: request.cwd,
        workspaceRoot,
        model: request.model,
        effort: request.effort,
        write: Boolean(request.write),
        unsafeShell,
        allowWideRoot: request.allowWideRoot === true
      },
      payload: buildTaskPayload(result, { sessionId, rawOutput, unsafeShell }),
      rendered: `${taskMetadata.title} is paused waiting for your approval to ${
        result.pendingApproval?.request ?? "a request"
      }.\nApprove: /copilot:approve\nDeny: /copilot:deny\n`,
      summary: `Paused: ${result.pendingApproval?.request ?? "awaiting approval"}`,
      jobTitle: taskMetadata.title,
      jobClass: "task",
      write: Boolean(request.write),
      unsafeShell
    };
  }

  const payload = buildTaskPayload(result, { sessionId: activeSessionId, rawOutput, unsafeShell });
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

  const copilotSessionId = result.sessionId ?? activeSessionId;
  return {
    exitStatus: rawOutput ? 0 : 1,
    sessionId: copilotSessionId,
    copilotSessionId,
    threadId: copilotSessionId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write),
    unsafeShell
  };
}

export function buildTaskRunMetadata({ prompt, resumeLast = false }) {
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

/**
 * A --write job whose root is the home directory or a drive root would be
 * allowed to edit everything the user owns. Refuse unless explicitly asked.
 */
export function assertWriteRootAcceptable({ write, allowWideRoot }, workspaceRoot) {
  if (!write || allowWideRoot || !isWideRoot(workspaceRoot)) return;
  throw new Error(
    `Refused to run a --write task with workspace root ${workspaceRoot}: it is your home directory, an ancestor of it, or a filesystem root, so "inside the workspace" would mean everything. Run from a project directory, or pass --allow-wide-root if you really mean it.`
  );
}

/**
 * Revive a job that was paused on the owner's approval. Resumes the Copilot
 * session (full history), allows the approved path, and re-instructs the model
 * to redo the action. Proven by the Phase 0 spike; a pending permission cannot
 * be frozen and continued, so the model re-attempts instead.
 */
export async function executeApprovalResume(request) {
  const workspaceRoot = request.workspaceRoot ?? resolveWorkspaceRoot(request.cwd);
  await ensureCopilotReady(request.cwd);
  // The revive context carries the original --write; the wide-root refusal
  // holds on the way back in as well.
  assertWriteRootAcceptable({ write: request.write, allowWideRoot: request.allowWideRoot }, workspaceRoot);

  const permissionMode = request.write ? WORKSPACE_WRITE : READ_ONLY;
  const approvedFile = request.pendingApproval?.file ?? null;
  const { session, resumed } = await resumeSession(request.copilotSessionId, {
    cwd: request.cwd,
    workspaceRoot,
    model: request.model,
    reasoningEffort: request.effort,
    permissionMode,
    unsafeShell: request.unsafeShell === true,
    extraPrograms: getConfig(workspaceRoot).extraPrograms ?? [],
    escalateReads: makeSentinelEscalation(),
    approvedReads: new Set(approvedFile ? [approvedFile] : []),
    // An approval-resume must reuse the frozen context; a fresh session would
    // silently restart the whole task. If the state is gone, the job expired.
    allowFreshFallback: false
  });

  if (!resumed || !session) {
    return {
      expired: true,
      exitStatus: 1,
      sessionId: request.copilotSessionId,
      payload: { status: 1, sessionId: request.copilotSessionId, rawOutput: "", touchedFiles: [], denials: [] },
      rendered: `This job's Copilot session (${request.copilotSessionId}) is no longer available, so it cannot be resumed. Re-run the original task.\n`,
      summary: "Session expired before approval",
      jobClass: "task"
    };
  }

  const target = request.pendingApproval?.request ?? (approvedFile ? `read ${approvedFile}` : "the paused action");
  const reinstruct = `The owner has approved the request that was paused (${target}). Please carry it out now and continue the task.`;
  const result = await runPrompt(session, reinstruct, { onProgress: request.onProgress });
  const rawOutput = result.content ?? "";

  // A second, different escalation can happen; re-suspend on the same path.
  if (result.escalated) {
    const copilotSessionId = result.sessionId ?? request.copilotSessionId;
    return {
      escalated: true,
      exitStatus: 0,
      sessionId: copilotSessionId,
      copilotSessionId,
      threadId: copilotSessionId,
      pendingApproval: result.pendingApproval,
      revive: {
        cwd: request.cwd,
        workspaceRoot,
        model: request.model,
        effort: request.effort,
        write: Boolean(request.write),
        unsafeShell: request.unsafeShell === true,
        allowWideRoot: request.allowWideRoot === true
      },
      payload: buildTaskPayload(result, { sessionId: copilotSessionId, rawOutput, unsafeShell: request.unsafeShell === true }),
      rendered: `Paused again waiting for your approval to ${result.pendingApproval?.request ?? "a request"}.\nApprove: /copilot:approve\nDeny: /copilot:deny\n`,
      summary: `Paused: ${result.pendingApproval?.request ?? "awaiting approval"}`,
      jobClass: "task"
    };
  }

  const payload = buildTaskPayload(result, {
    sessionId: request.copilotSessionId,
    rawOutput,
    unsafeShell: request.unsafeShell === true
  });
  const rendered = renderTaskResult(
    { rawOutput, failureMessage: "", reasoningSummary: payload.reasoningSummary },
    {
      title: request.title ?? "Copilot Task",
      jobId: request.jobId ?? null,
      write: Boolean(request.write),
      touchedFiles: payload.touchedFiles,
      denials: payload.denials,
      unsafeShell: request.unsafeShell === true
    }
  );
  const finalSessionId = result.sessionId ?? request.copilotSessionId;
  return {
    exitStatus: rawOutput ? 0 : 1,
    sessionId: finalSessionId,
    copilotSessionId: finalSessionId,
    threadId: finalSessionId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, "Resumed after approval."),
    jobClass: "task",
    write: Boolean(request.write)
  };
}
