import fs from "node:fs";

import { getSessionRuntimeStatus } from "./copilot-client.mjs";
import { isProcessAlive } from "./process.mjs";
import {
  AWAITING_APPROVAL,
  COMPLETED_DEGRADED,
  getConfig,
  isTerminalStatus,
  listJobs,
  readJobFile,
  resolveJobFile,
  upsertJob,
  writeJobFile
} from "./state.mjs";
import { SESSION_ID_ENV } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

/** Jobs the worker is actively driving (or about to). */
function isActive(job) {
  return job.status === "queued" || job.status === "running";
}
/** Paused waiting on the owner's approval — worker has exited, but not finished. */
function isAwaitingApproval(job) {
  return job.status === AWAITING_APPROVAL;
}

export const DEFAULT_MAX_STATUS_JOBS = 8;
export const DEFAULT_MAX_PROGRESS_LINES = 4;

/**
 * A queued job whose worker never recorded a pid is given this long before it
 * counts as stale; the spawn itself takes well under a second.
 */
export const STALE_QUEUED_AFTER_MS = 5 * 60 * 1000;

/**
 * An active job whose worker is gone. Workers die without updating their
 * record when they are killed, run out of memory, or the machine reboots;
 * nothing else ever moves such a job on.
 *
 * @param {object} job
 * @param {{isAlive?: (pid: number) => boolean, now?: number}} [options]
 */
export function isStaleJob(job, options = {}) {
  if (!isActive(job)) return false;
  const isAlive = options.isAlive ?? isProcessAlive;
  if (Number.isFinite(job.pid) && job.pid > 0) {
    return !isAlive(job.pid);
  }
  if (job.status === "queued") {
    const since = Date.parse(job.updatedAt ?? job.createdAt ?? "");
    const now = options.now ?? Date.now();
    return Number.isFinite(since) && now - since > STALE_QUEUED_AFTER_MS;
  }
  return false;
}

/**
 * Close jobs whose worker is gone.
 *
 * `isStaleJob` already answers the question on every status read; this acts on
 * the answer instead of only printing "the worker is gone" forever. Costs one
 * filter when nothing is active, and touches state only when it finds
 * something, so it is safe to call on the way into a command.
 *
 * @param {string} cwd
 * @param {{isAlive?: (pid: number) => boolean, now?: number}} [options]
 * @returns {{reaped: string[]}}
 */
export function reapStaleJobs(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stale = listJobs(workspaceRoot).filter((job) => isStaleJob(job, options));
  if (stale.length === 0) {
    return { reaped: [] };
  }

  const completedAt = new Date().toISOString();
  for (const job of stale) {
    const patch = {
      id: job.id,
      status: "failed",
      phase: "failed",
      pid: null,
      errorMessage: "The worker process is gone; the job never finished.",
      completedAt
    };
    try {
      upsertJob(workspaceRoot, patch);
      const stored = readStoredJob(workspaceRoot, job.id);
      if (stored) {
        // The job file and the index have to agree, or /copilot:result and
        // /copilot:status tell the owner two different stories.
        writeJobFile(workspaceRoot, job.id, { ...stored, ...patch });
      }
    } catch {
      // A job we could not close is reported as stale next time, as before.
    }
  }
  return { reaped: stale.map((job) => job.id) };
}

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

function getCurrentSessionId(options = {}) {
  return options.env?.[SESSION_ID_ENV] ?? process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentSession(jobs, options = {}) {
  const sessionId = getCurrentSessionId(options);
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function getJobTypeLabel(job) {
  if (typeof job.kindLabel === "string" && job.kindLabel) {
    return job.kindLabel;
  }
  if (job.kind === "adversarial-review") {
    return "adversarial-review";
  }
  if (job.jobClass === "review") {
    return "review";
  }
  if (job.jobClass === "task") {
    return "rescue";
  }
  if (job.kind === "review") {
    return "review";
  }
  if (job.kind === "task") {
    return "rescue";
  }
  return "job";
}

function stripLogPrefix(line) {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}

function isProgressBlockTitle(line) {
  return (
    ["Final output", "Assistant message", "Reasoning summary", "Review output"].includes(line) ||
    /^Subagent .+ message$/.test(line) ||
    /^Subagent .+ reasoning summary$/.test(line)
  );
}

export function readJobProgressPreview(logFile, maxLines = DEFAULT_MAX_PROGRESS_LINES) {
  if (!logFile || !fs.existsSync(logFile)) {
    return [];
  }

  const lines = fs
    .readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => line.startsWith("["))
    .map(stripLogPrefix)
    .filter((line) => line && !isProgressBlockTitle(line));

  return lines.slice(-maxLines);
}

function formatElapsedDuration(startValue, endValue = null) {
  const start = Date.parse(startValue ?? "");
  if (!Number.isFinite(start)) {
    return null;
  }

  const end = endValue ? Date.parse(endValue) : Date.now();
  if (!Number.isFinite(end) || end < start) {
    return null;
  }

  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function looksLikeVerificationCommand(line) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    line
  );
}

function inferLegacyJobPhase(job, progressPreview = []) {
  switch (job.status) {
    case "queued":
      return "queued";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "completed":
      return "done";
    case COMPLETED_DEGRADED:
      return "degraded";
    case AWAITING_APPROVAL:
      return "awaiting-approval";
    default:
      break;
  }

  for (let index = progressPreview.length - 1; index >= 0; index -= 1) {
    const line = progressPreview[index].toLowerCase();
    if (line.startsWith("starting copilot") || line.startsWith("thread ready") || line.startsWith("turn started")) {
      return "starting";
    }
    if (line.startsWith("reviewer started") || line.includes("review mode")) {
      return "reviewing";
    }
    if (line.startsWith("searching:") || line.startsWith("calling ") || line.startsWith("running tool:")) {
      return "investigating";
    }
    if (line.startsWith("starting collaboration tool:")) {
      return "investigating";
    }
    if (line.startsWith("running command:")) {
      return looksLikeVerificationCommand(line)
        ? "verifying"
        : job.jobClass === "review"
          ? "reviewing"
          : "investigating";
    }
    if (line.startsWith("command completed:")) {
      return looksLikeVerificationCommand(line) ? "verifying" : "running";
    }
    if (line.startsWith("applying ") || line.startsWith("file changes ")) {
      return "editing";
    }
    if (line.startsWith("turn completed")) {
      return "finalizing";
    }
    if (line.startsWith("copilot error:") || line.startsWith("failed:")) {
      return "failed";
    }
  }

  return job.jobClass === "review" ? "reviewing" : "running";
}

export function enrichJob(job, options = {}) {
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const stale = isStaleJob(job, { isAlive: options.isAlive, now: options.now });
  const enriched = {
    ...job,
    kindLabel: getJobTypeLabel(job),
    stale,
    progressPreview:
      job.status === "queued" || job.status === "running" || job.status === "failed"
        ? readJobProgressPreview(job.logFile, maxProgressLines)
        : [],
    elapsed: formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? null),
    duration: isTerminalStatus(job.status)
      ? formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt)
      : null
  };

  return {
    ...enriched,
    // A stale job's stored phase describes a worker that no longer exists.
    phase: stale ? "stale" : (enriched.phase ?? inferLegacyJobPhase(enriched, enriched.progressPreview))
  };
}

export function readStoredJob(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

function matchJobReference(jobs, reference, predicate = () => true) {
  const filtered = jobs.filter(predicate);
  if (!reference) {
    return filtered[0] ?? null;
  }

  const exact = filtered.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }

  const prefixMatches = filtered.filter((job) => job.id.startsWith(reference));
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  if (prefixMatches.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
  }

  throw new Error(`No job found for "${reference}". Run /copilot:status to list known jobs.`);
}

export function buildStatusSnapshot(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const allJobs = listJobs(workspaceRoot);
  const sessionJobs = filterJobsForCurrentSession(allJobs, options);
  // --all shows every session's jobs for this workspace, not just this one's.
  const jobs = sortJobsNewestFirst(options.all ? allJobs : sessionJobs);
  const otherSessions = options.all ? allJobs.length - sessionJobs.length : 0;
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;

  const running = jobs.filter(isActive).map((job) => enrichJob(job, { maxProgressLines }));

  // Jobs paused on the owner's approval get their own bucket: neither "running"
  // (the worker has exited) nor "finished" (there is still work to do).
  const awaitingApproval = jobs.filter(isAwaitingApproval).map((job) => enrichJob(job, { maxProgressLines }));

  const isFinished = (job) => !isActive(job) && !isAwaitingApproval(job);
  const latestFinishedRaw = jobs.find(isFinished) ?? null;
  const latestFinished = latestFinishedRaw ? enrichJob(latestFinishedRaw, { maxProgressLines }) : null;

  const recent = (options.all ? jobs : jobs.slice(0, maxJobs))
    .filter((job) => isFinished(job) && job.id !== latestFinished?.id)
    .map((job) => enrichJob(job, { maxProgressLines }));

  return {
    workspaceRoot,
    config,
    sessionRuntime: getSessionRuntimeStatus(),
    running,
    awaitingApproval,
    latestFinished,
    recent,
    otherSessions,
    needsReview: Boolean(config.stopReviewGate)
  };
}

export function buildSingleJobSnapshot(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const selected = matchJobReference(jobs, reference);
  if (!selected) {
    throw new Error(`No job found for "${reference}". Run /copilot:status to inspect known jobs.`);
  }

  const job = enrichJob(selected, { maxProgressLines: options.maxProgressLines });
  // The index never carries the preview, so a single-job view reads the file.
  // Only while the job is active: once it is done, `rendered` is the answer.
  if (job.status === "queued" || job.status === "running") {
    const stored = readStoredJob(workspaceRoot, job.id);
    if (stored?.partialOutput) job.partialOutput = stored.partialOutput;
  }

  return { workspaceRoot, job };
}

function explainUnfinished(job) {
  if (isAwaitingApproval(job)) {
    return new Error(
      `Job ${job.id} is paused waiting for your approval to ${job.pendingApproval?.request ?? "a request"}. Run /copilot:approve ${job.id} to allow it or /copilot:deny ${job.id} to refuse.`
    );
  }
  return new Error(`Job ${job.id} is still ${job.status}. Check /copilot:status and try again once it finishes.`);
}

export function resolveResultJob(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(reference ? listJobs(workspaceRoot) : filterJobsForCurrentSession(listJobs(workspaceRoot)));

  if (reference) {
    // Find the job first, then judge its state: a running job asked for by id
    // used to be reported as "no job found".
    const job = matchJobReference(jobs, reference);
    if (isTerminalStatus(job.status)) {
      return { workspaceRoot, job };
    }
    throw explainUnfinished(job);
  }

  const selected = matchJobReference(jobs, reference, (job) => isTerminalStatus(job.status));
  if (selected) {
    return { workspaceRoot, job: selected };
  }

  const unfinished = matchJobReference(jobs, reference, (job) => isAwaitingApproval(job) || isActive(job));
  if (unfinished) {
    throw explainUnfinished(unfinished);
  }

  if (reference) {
    throw new Error(`No finished job found for "${reference}". Run /copilot:status to inspect active jobs.`);
  }

  throw new Error("No finished Copilot jobs found for this repository yet.");
}

export function resolveCancelableJob(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  // A job paused on approval is cancelable too — cancelling abandons the pending
  // request rather than approving or denying it.
  const cancelable = jobs.filter((job) => isActive(job) || isAwaitingApproval(job));

  if (reference) {
    const selected = matchJobReference(cancelable, reference);
    if (!selected) {
      throw new Error(`No active job found for "${reference}".`);
    }
    return { workspaceRoot, job: selected };
  }

  if (cancelable.length === 1) {
    return { workspaceRoot, job: cancelable[0] };
  }
  if (cancelable.length > 1) {
    throw new Error("Multiple Copilot jobs are active. Pass a job id to /copilot:cancel.");
  }

  throw new Error("No active Copilot jobs to cancel.");
}

/**
 * Resolve a job that is paused on the owner's approval, for `/copilot:approve`
 * and `/copilot:deny`. Without a reference, the single awaiting job is chosen;
 * with several, a job id is required.
 */
export function resolveApprovableJob(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const awaiting = jobs.filter(isAwaitingApproval);

  if (reference) {
    const selected = matchJobReference(awaiting, reference);
    if (!selected) {
      throw new Error(`No job awaiting approval found for "${reference}". Run /copilot:status to list them.`);
    }
    return { workspaceRoot, job: selected };
  }

  if (awaiting.length === 1) {
    return { workspaceRoot, job: awaiting[0] };
  }
  if (awaiting.length > 1) {
    throw new Error("Multiple Copilot jobs are awaiting approval. Pass a job id.");
  }

  throw new Error("No Copilot jobs are awaiting approval.");
}
