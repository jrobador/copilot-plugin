#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getCopilotAvailability } from "./lib/copilot-client.mjs";
import { getWorkingTreeState } from "./lib/git.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { AWAITING_APPROVAL, getConfig, isInPlayStatus, listJobs, setConfig } from "./lib/state.mjs";
import { sortJobsNewestFirst } from "./lib/job-control.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

/**
 * Below the hook's own timeout (900 s in hooks.json) so the "timed out"
 * verdict is emitted by this script rather than lost when the host kills it.
 */
const STOP_REVIEW_TIMEOUT_MS = 13 * 60 * 1000;

/**
 * The gate blocks a stop, Claude keeps working, the gate blocks again: with
 * no one watching, that is a loop that only ends when the usage limit does.
 * After this many consecutive blocks the gate switches itself off.
 */
export const GATE_MAX_CONSECUTIVE_BLOCKS = 2;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function logNote(message) {
  if (!message) {
    return;
  }
  process.stderr.write(`${message}\n`);
}

function filterJobsForCurrentSession(jobs, input = {}) {
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function buildStopReviewPrompt(input = {}) {
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  const template = loadPromptTemplate(ROOT_DIR, "stop-review-gate");
  const claudeResponseBlock = lastAssistantMessage
    ? ["Previous Claude response:", lastAssistantMessage].join("\n")
    : "";
  return interpolateTemplate(template, {
    CLAUDE_RESPONSE_BLOCK: claudeResponseBlock
  });
}

/**
 * Cheap availability probe.
 *
 * This runs on every Stop, so it deliberately checks the binary rather than
 * calling getCopilotLoginStatus(), which would boot a Copilot CLI process just
 * to answer a yes/no question. A real auth failure surfaces from the review run
 * itself a moment later.
 */
function buildSetupNote(cwd) {
  const copilotStatus = getCopilotAvailability(cwd);
  if (!copilotStatus.available) {
    const detail = copilotStatus.detail ? ` ${copilotStatus.detail}.` : "";
    return `Copilot is not installed for the review gate.${detail} Run /copilot:setup to install it.`;
  }
  return null;
}

/**
 * Three outcomes, not two: the reviewer said ALLOW (`ok`), the reviewer said
 * BLOCK (`blocked`), or the review could not be had at all (neither). Only
 * the second one is a reason to keep Claude working; the third is an
 * infrastructure problem and is logged instead.
 *
 * @returns {{ok: boolean, blocked: boolean, reason: string|null}}
 */
export function parseStopReviewOutput(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return {
      ok: false,
      blocked: false,
      reason: "The stop-time Copilot review task returned no final output. Run /copilot:review --wait manually if you want a review."
    };
  }

  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:")) {
    return { ok: true, blocked: false, reason: null };
  }
  if (firstLine.startsWith("BLOCK:")) {
    const reason = firstLine.slice("BLOCK:".length).trim() || text;
    return {
      ok: false,
      blocked: true,
      reason: `Copilot stop-time review found issues that still need fixes before ending the session: ${reason}`
    };
  }

  return {
    ok: false,
    blocked: false,
    reason: "The stop-time Copilot review task returned an unexpected answer. Run /copilot:review --wait manually if you want a review."
  };
}

/**
 * Run the stop-gate review as a companion `task` and interpret its answer.
 *
 * @param {string} cwd
 * @param {object} [input]  The hook's stdin payload.
 * @param {{spawnImpl?: typeof spawnSync}} [seams]  Test seam for the child process.
 * @returns {{ok: boolean, blocked: boolean, reason: string|null}}
 */
export function runStopReview(cwd, input = {}, seams = {}) {
  const spawnImpl = seams.spawnImpl ?? spawnSync;
  const scriptPath = path.join(SCRIPT_DIR, "copilot-companion.mjs");
  const prompt = buildStopReviewPrompt(input);
  const childEnv = {
    ...process.env,
    ...(input.session_id ? { [SESSION_ID_ENV]: input.session_id } : {})
  };
  const result = spawnImpl(process.execPath, [scriptPath, "task", "--json", prompt], {
    cwd,
    env: childEnv,
    encoding: "utf8",
    timeout: STOP_REVIEW_TIMEOUT_MS
  });

  if (/** @type {NodeJS.ErrnoException|undefined} */ (result.error)?.code === "ETIMEDOUT") {
    return {
      ok: false,
      blocked: false,
      reason: `The stop-time Copilot review task timed out after ${Math.round(STOP_REVIEW_TIMEOUT_MS / 60000)} minutes; the stop was not blocked.`
    };
  }

  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    return {
      ok: false,
      blocked: false,
      reason: detail
        ? `The stop-time Copilot review task failed and the stop was not blocked: ${detail}`
        : "The stop-time Copilot review task failed; the stop was not blocked."
    };
  }

  try {
    const payload = JSON.parse(result.stdout);
    return parseStopReviewOutput(payload?.rawOutput);
  } catch {
    return {
      ok: false,
      blocked: false,
      reason: "The stop-time Copilot review task returned invalid JSON; the stop was not blocked."
    };
  }
}

/**
 * What the hook tells Claude Code about a finished review: a block decision,
 * or null to let the stop proceed. Only an explicit BLOCK verdict blocks; a
 * review that could not run is not a finding.
 *
 * @param {{ok: boolean, blocked?: boolean, reason: string|null}} review
 * @param {string|null} [runningTaskNote]
 * @returns {{decision: "block", reason: string}|null}
 */
export function decideStop(review, runningTaskNote = null) {
  if (review.blocked !== true) {
    return null;
  }
  return {
    decision: "block",
    reason: runningTaskNote ? `${runningTaskNote} ${review.reason}` : review.reason
  };
}

/**
 * Count consecutive blocks and switch the gate off once the budget is spent.
 *
 * @param {string} workspaceRoot
 * @param {boolean} blocked  Whether this stop is being blocked.
 * @returns {{count: number, disabled: boolean}}
 */
export function applyBlockBudget(workspaceRoot, blocked) {
  const config = getConfig(workspaceRoot);
  const previous = Number.isInteger(config.gateConsecutiveBlocks) ? config.gateConsecutiveBlocks : 0;
  if (!blocked) {
    if (previous !== 0) setConfig(workspaceRoot, "gateConsecutiveBlocks", 0);
    return { count: 0, disabled: false };
  }
  const count = previous + 1;
  if (count >= GATE_MAX_CONSECUTIVE_BLOCKS) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    setConfig(workspaceRoot, "gateConsecutiveBlocks", 0);
    return { count, disabled: true };
  }
  setConfig(workspaceRoot, "gateConsecutiveBlocks", count);
  return { count, disabled: false };
}

/** Is there anything for a stop-gate review to look at? Unknown counts as yes. */
function workingTreeIsClean(workspaceRoot) {
  try {
    return !getWorkingTreeState(workspaceRoot).isDirty;
  } catch {
    return false;
  }
}

export function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);

  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), input));
  const inPlayJob = jobs.find((job) => isInPlayStatus(job.status));
  const runningTaskNote = inPlayJob
    ? inPlayJob.status === AWAITING_APPROVAL
      ? `Copilot task ${inPlayJob.id} is paused waiting for your approval. Run /copilot:approve ${inPlayJob.id} or /copilot:deny ${inPlayJob.id} before ending the session, or it stays paused.`
      : `Copilot task ${inPlayJob.id} is still running. Check /copilot:status and use /copilot:cancel ${inPlayJob.id} if you want to stop it before ending the session.`
    : null;

  if (!config.stopReviewGate) {
    logNote(runningTaskNote);
    return;
  }

  const setupNote = buildSetupNote(cwd);
  if (setupNote) {
    logNote(setupNote);
    logNote(runningTaskNote);
    return;
  }

  // A turn that changed nothing has nothing to review; skip the Copilot run
  // (and its cost) instead of asking the model to confirm that.
  if (workingTreeIsClean(workspaceRoot)) {
    logNote("Review gate: the working tree is clean, nothing to review.");
    logNote(runningTaskNote);
    return;
  }

  const review = runStopReview(cwd, input);
  const stop = decideStop(review, runningTaskNote);
  const budget = applyBlockBudget(workspaceRoot, Boolean(stop));
  if (stop) {
    if (budget.disabled) {
      stop.reason = `${stop.reason} (Review gate disabled after ${budget.count} consecutive blocks; re-enable with /copilot:setup --enable-review-gate.)`;
    }
    emitDecision(stop);
    return;
  }

  if (!review.ok) {
    logNote(`Review gate: ${review.reason}`);
  }
  logNote(runningTaskNote);
}

// Only run as a hook when executed directly; tests import the pieces above.
const isEntrypoint =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntrypoint) {
  main();
}
