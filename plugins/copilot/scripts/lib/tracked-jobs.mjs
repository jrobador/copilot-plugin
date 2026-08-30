import fs from "node:fs";
import process from "node:process";

import { terminateProcessTree } from "./process.mjs";
import { AWAITING_APPROVAL, readJobFile, resolveJobFile, resolveJobLogFile, upsertJob, writeJobFile } from "./state.mjs";

export const SESSION_ID_ENV = "COPILOT_COMPANION_SESSION_ID";

/** Does this command line belong to a companion process (worker or foreground run)? */
export function isCompanionCommandLine(commandLine) {
  return typeof commandLine === "string" && /copilot-companion\.mjs/.test(commandLine);
}

/**
 * Kill the worker behind a job, but only if the pid still is one. The record
 * may be hours old and the pid reused by something unrelated.
 *
 * @param {number|null|undefined} pid
 * @param {object} [options]  Passed to terminateProcessTree (test seams).
 */
export function terminateWorker(pid, options = {}) {
  return terminateProcessTree(pid ?? Number.NaN, { identity: isCompanionCommandLine, ...options });
}

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

/**
 * A new job record. `sessionId` is the **Claude Code** session the job was
 * started from (COPILOT_COMPANION_SESSION_ID); it scopes /copilot:status and
 * the SessionEnd cleanup. The Copilot session the job talks to is recorded
 * separately, as `copilotSessionId`, once the run reports it.
 */
export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (!changed) {
      return;
    }

    upsertJob(workspaceRoot, patch);

    const jobFile = resolveJobFile(workspaceRoot, jobId);
    if (!fs.existsSync(jobFile)) {
      return;
    }

    const storedJob = readJobFile(jobFile);
    writeJobFile(workspaceRoot, jobId, {
      ...storedJob,
      ...patch
    });
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[copilot] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

export async function runTrackedJob(job, runner, options = {}) {
  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    logFile: options.logFile ?? job.logFile ?? null
  };
  writeJobFile(job.workspaceRoot, job.id, runningRecord);
  upsertJob(job.workspaceRoot, runningRecord);
  const logFile = options.logFile ?? job.logFile ?? null;
  appendLogLine(
    logFile,
    `Job ${job.id}: mode=${job.write ? "workspace-write" : "read-only"} model=${job.model ?? "default"} effort=${job.effort ?? "default"} pid=${process.pid}`
  );

  try {
    const execution = await runner();
    const metrics = execution.metrics ?? {};
    appendLogLine(
      logFile,
      `Run: model=${metrics.model ?? "?"} promptBytes=${metrics.promptBytes ?? "?"} outputTokens=${metrics.outputTokens ?? "?"} toolCalls=${metrics.toolCalls ?? 0} denials=${metrics.denials ?? 0} touchedFiles=${metrics.touchedFiles ?? 0} escalated=${metrics.escalated ? "yes" : "no"} copilotSessionId=${execution.copilotSessionId ?? execution.sessionId ?? "?"}`
    );

    // The policy paused a request for the owner: the worker finished its turn but
    // the job is not done. Store it as awaiting-approval, carrying everything a
    // later /copilot:approve needs to revive it, and exit without a terminal
    // status. Pruning protects this state (see state.mjs).
    if (execution.escalated) {
      const copilotSessionId = execution.copilotSessionId ?? execution.sessionId ?? null;
      const awaitingRecord = {
        ...runningRecord,
        status: AWAITING_APPROVAL,
        phase: "awaiting-approval",
        pid: null,
        threadId: copilotSessionId,
        copilotSessionId,
        pendingApproval: execution.pendingApproval ?? null,
        revive: execution.revive ?? null,
        updatedAt: nowIso(),
        result: execution.payload,
        rendered: execution.rendered
      };
      writeJobFile(job.workspaceRoot, job.id, awaitingRecord);
      upsertJob(job.workspaceRoot, {
        id: job.id,
        status: AWAITING_APPROVAL,
        phase: "awaiting-approval",
        pid: null,
        threadId: copilotSessionId,
        copilotSessionId,
        pendingApproval: execution.pendingApproval ?? null,
        revive: execution.revive ?? null,
        summary: execution.summary
      });
      appendLogBlock(options.logFile ?? job.logFile ?? null, "Paused for approval", execution.rendered);
      return execution;
    }

    // The session state was pruned before an approval-resume could reach it.
    if (execution.expired) {
      const completedAt = nowIso();
      writeJobFile(job.workspaceRoot, job.id, {
        ...runningRecord,
        status: "expired",
        phase: "failed",
        pid: null,
        completedAt,
        result: execution.payload,
        rendered: execution.rendered
      });
      upsertJob(job.workspaceRoot, {
        id: job.id,
        status: "expired",
        phase: "failed",
        pid: null,
        summary: execution.summary,
        completedAt
      });
      appendLogBlock(options.logFile ?? job.logFile ?? null, "Expired", execution.rendered);
      return execution;
    }

    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    // The Copilot session behind this job. Kept under both names: threadId is
    // what the renderers print, copilotSessionId is what a later resume reads.
    const copilotSessionId = execution.copilotSessionId ?? execution.threadId ?? execution.sessionId ?? null;
    writeJobFile(job.workspaceRoot, job.id, {
      ...runningRecord,
      status: completionStatus,
      threadId: copilotSessionId,
      copilotSessionId,
      turnId: execution.turnId ?? null,
      pid: null,
      phase: completionStatus === "completed" ? "done" : "failed",
      completedAt,
      result: execution.payload,
      rendered: execution.rendered
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: completionStatus,
      threadId: copilotSessionId,
      copilotSessionId,
      turnId: execution.turnId ?? null,
      summary: execution.summary,
      phase: completionStatus === "completed" ? "done" : "failed",
      pid: null,
      completedAt
    });
    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    const completedAt = nowIso();
    writeJobFile(job.workspaceRoot, job.id, {
      ...existing,
      status: "failed",
      phase: "failed",
      errorMessage,
      pid: null,
      completedAt,
      logFile: options.logFile ?? job.logFile ?? existing.logFile ?? null
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: "failed",
      phase: "failed",
      pid: null,
      errorMessage,
      completedAt
    });
    throw error;
  }
}
