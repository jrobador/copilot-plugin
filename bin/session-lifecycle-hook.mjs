#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { loadState, resolveStateFile, saveState } from "../lib/state.mjs";
import { terminateWorker } from "../lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "../lib/workspace.mjs";

export const SESSION_ID_ENV = "COPILOT_PLUGIN_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function readHookInput() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") return;
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

/**
 * The Claude session is ending: stop the workers it started, and close their
 * records. Finished jobs and jobs paused for approval are kept -- a result
 * should survive a restart, and a paused job still has its revive context.
 *
 * @param {string} cwd
 * @param {string} sessionId  The Claude Code session id.
 * @param {{terminate?: typeof terminateWorker}} [seams]
 */
export function cleanupSessionJobs(cwd, sessionId, seams = {}) {
  if (!cwd || !sessionId) return { stopped: [] };
  const terminate = seams.terminate ?? terminateWorker;
  const stopped = [];
  try {
    const workspaceRoot = resolveWorkspaceRoot(cwd);
    const stateFile = resolveStateFile(workspaceRoot);
    if (!fs.existsSync(stateFile)) return { stopped };

    const state = loadState(workspaceRoot);
    const completedAt = new Date().toISOString();
    const jobs = state.jobs.map((job) => {
      if (job.sessionId !== sessionId || !(job.status === "queued" || job.status === "running")) {
        return job;
      }
      try {
        terminate(job.pid);
      } catch {
        // Best effort.
      }
      stopped.push(job.id);
      return {
        ...job,
        status: "cancelled",
        phase: "cancelled",
        pid: null,
        completedAt,
        errorMessage: "Cancelled: the Claude session that started it ended."
      };
    });

    if (stopped.length > 0) {
      saveState(workspaceRoot, { ...state, jobs });
    }
  } catch {
    // Best-effort cleanup
  }
  return { stopped };
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV]);
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }
  if (eventName === "SessionEnd") {
    handleSessionEnd(input);
  }
}

// Only run as a hook when executed directly; tests import cleanupSessionJobs.
const isEntrypoint =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntrypoint) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
