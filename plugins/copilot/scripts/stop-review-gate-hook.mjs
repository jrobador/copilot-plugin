#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getCopilotAvailability } from "./lib/copilot-client.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { getConfig, listJobs } from "./lib/state.mjs";
import { sortJobsNewestFirst } from "./lib/job-control.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const STOP_REVIEW_TIMEOUT_MS = 15 * 60 * 1000;
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

export function parseStopReviewOutput(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return {
      ok: false,
      reason:
        "The stop-time Copilot review task returned no final output. Run /copilot:review --wait manually or bypass the gate."
    };
  }

  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:")) {
    return { ok: true, reason: null };
  }
  if (firstLine.startsWith("BLOCK:")) {
    const reason = firstLine.slice("BLOCK:".length).trim() || text;
    return {
      ok: false,
      reason: `Copilot stop-time review found issues that still need fixes before ending the session: ${reason}`
    };
  }

  return {
    ok: false,
    reason:
      "The stop-time Copilot review task returned an unexpected answer. Run /copilot:review --wait manually or bypass the gate."
  };
}

/**
 * Run the stop-gate review as a companion `task` and interpret its answer.
 *
 * @param {string} cwd
 * @param {object} [input]  The hook's stdin payload.
 * @param {{spawnImpl?: typeof spawnSync}} [seams]  Test seam for the child process.
 * @returns {{ok: boolean, reason: string|null}}
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
      reason:
        "The stop-time Copilot review task timed out after 15 minutes. Run /copilot:review --wait manually or bypass the gate."
    };
  }

  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    return {
      ok: false,
      reason: detail
        ? `The stop-time Copilot review task failed: ${detail}`
        : "The stop-time Copilot review task failed. Run /copilot:review --wait manually or bypass the gate."
    };
  }

  try {
    const payload = JSON.parse(result.stdout);
    return parseStopReviewOutput(payload?.rawOutput);
  } catch {
    return {
      ok: false,
      reason:
        "The stop-time Copilot review task returned invalid JSON. Run /copilot:review --wait manually or bypass the gate."
    };
  }
}

/**
 * What the hook tells Claude Code about a finished review: a block decision,
 * or null to let the stop proceed.
 *
 * @param {{ok: boolean, reason: string|null}} review
 * @param {string|null} [runningTaskNote]
 * @returns {{decision: "block", reason: string}|null}
 */
export function decideStop(review, runningTaskNote = null) {
  if (review.ok) {
    return null;
  }
  return {
    decision: "block",
    reason: runningTaskNote ? `${runningTaskNote} ${review.reason}` : review.reason
  };
}

export function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);

  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), input));
  const runningJob = jobs.find((job) => job.status === "queued" || job.status === "running");
  const runningTaskNote = runningJob
    ? `Copilot task ${runningJob.id} is still running. Check /copilot:status and use /copilot:cancel ${runningJob.id} if you want to stop it before ending the session.`
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

  const review = runStopReview(cwd, input);
  const stop = decideStop(review, runningTaskNote);
  if (stop) {
    emitDecision(stop);
    return;
  }

  logNote(runningTaskNote);
}

// Only run as a hook when executed directly; tests import the pieces above.
const isEntrypoint =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntrypoint) {
  main();
}
