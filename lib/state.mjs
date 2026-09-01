import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
/**
 * Where job records go when Claude Code did not hand us CLAUDE_PLUGIN_DATA.
 * Under the home directory, not the shared temp dir: the records hold prompts,
 * diffs and model output.
 */
const FALLBACK_STATE_ROOT_DIR = path.join(os.homedir(), ".copilot-plugin");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const LOCK_DIR_NAME = "state.lock";
const MAX_JOBS = 50;

/** A lock this old belonged to a worker that died holding it; break it. */
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 5;

/** A job blocked on the owner's approval of a permission (see permissions.mjs). */
export const AWAITING_APPROVAL = "awaiting-approval";

/**
 * Finished, produced output, but something it asked for was refused: a read
 * outside the fence, a command the mode does not allow, a program missing from
 * PATH. The distinction exists because a run that saw three quarters of the
 * code and reported nothing is not the same answer as a run that saw all of it,
 * and the caller cannot tell them apart from the output alone.
 */
export const COMPLETED_DEGRADED = "completed-degraded";

/**
 * Finished states: safe to prune and delete.
 */
export const TERMINAL_STATUSES = new Set(["completed", COMPLETED_DEGRADED, "failed", "cancelled", "expired"]);

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

/**
 * States where a worker is running, about to run, or paused waiting on the
 * owner. These are protected from pruning so a job still in play is never
 * deleted out from under a later `/copilot:approve` or status check. Protection
 * is opt-in for these known states; anything else (finished, or a legacy record
 * with no status) competes for the MAX_JOBS budget as before.
 */
export const IN_PLAY_STATUSES = new Set(["queued", "running", AWAITING_APPROVAL]);

export function isInPlayStatus(status) {
  return IN_PLAY_STATUSES.has(status);
}

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false,
      // Extra programs run_command may spawn in --write jobs; see `setup --allow-programs`.
      extraPrograms: []
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  // Owner-only on POSIX (ignored on Windows): the records hold repository
  // content and model output.
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true, mode: 0o700 });
}

/** Fields that live in the job file only; the index never carries them. */
const JOB_FILE_ONLY_FIELDS = new Set(["result", "rendered", "request", "partialOutput"]);

function indexEntryOf(job) {
  const entry = {};
  for (const [key, value] of Object.entries(job)) {
    if (!JOB_FILE_ONLY_FIELDS.has(key)) entry[key] = value;
  }
  return entry;
}

/**
 * Rebuild the job index from the job files. Every job the runtime creates
 * has one (enqueue, runTrackedJob and approve all write it), so the files are
 * the durable record and the index is a cache of them.
 */
function reindexJobs(cwd) {
  const dir = resolveJobsDir(cwd);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const jobs = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const job = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      if (job && typeof job === "object" && typeof job.id === "string") {
        jobs.push(indexEntryOf(job));
      }
    } catch {
      // A half-written job file is skipped, not fatal.
    }
  }
  return jobs;
}

/** Move an unreadable state file aside so it can be inspected, never overwritten. */
function quarantine(stateFile) {
  try {
    fs.renameSync(stateFile, `${stateFile}.corrupt-${Date.now().toString(36)}`);
  } catch {
    // Leave it; the next atomic save replaces it anyway.
  }
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    // No index, but maybe job files: a quarantined or deleted index must not
    // make the jobs disappear. On a brand-new workspace this finds nothing.
    const jobs = reindexJobs(cwd);
    return jobs.length > 0 ? { ...defaultState(), jobs, recovered: true } : defaultState();
  }

  let raw;
  try {
    raw = fs.readFileSync(stateFile, "utf8");
  } catch {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(raw);
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    // A truncated or half-written index used to read as "no jobs", and the
    // next save persisted that emptiness. Quarantine the file and rebuild the
    // index from the job files instead, so nothing is dropped.
    quarantine(stateFile);
    return { ...defaultState(), jobs: reindexJobs(cwd), recovered: true };
  }
}

/** Block this thread; the critical sections here are milliseconds long. */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isStaleLock(lockDir) {
  try {
    return Date.now() - fs.statSync(lockDir).mtimeMs > LOCK_STALE_MS;
  } catch {
    // Already gone: the next mkdir attempt takes it.
    return false;
  }
}

/**
 * Run `fn` with exclusive access to this workspace's state.
 *
 * Every writer is a separate process (background workers, hooks, the CLI), so
 * the lock has to live on disk. `mkdir` is the create-if-absent primitive
 * every OS agrees is atomic, so the directory itself is the lock. A lock left
 * behind by a killed worker is broken once it goes stale: waiting forever on
 * a dead process is worse than the race it was meant to prevent.
 */
export function withStateLock(cwd, fn) {
  ensureStateDir(cwd);
  const lockDir = path.join(resolveStateDir(cwd), LOCK_DIR_NAME);
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (isStaleLock(lockDir)) {
        try {
          fs.rmdirSync(lockDir);
        } catch {
          // Another writer broke it first; just retry.
        }
      }
      sleep(LOCK_RETRY_MS);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.rmdirSync(lockDir);
    } catch {
      // Nothing to release.
    }
  }
}

/**
 * Replace the state file in one step. Readers see the old file or the new
 * one, never a partially written one. Windows can refuse the rename while
 * another process still has the file open; retry briefly.
 */
function writeFileAtomic(file, content) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  fs.writeFileSync(tmp, content, "utf8");
  let lastError = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== "EPERM" && error?.code !== "EBUSY" && error?.code !== "EACCES") break;
      sleep(5 * (attempt + 1));
    }
  }
  try {
    fs.unlinkSync(tmp);
  } catch {
    // Nothing more to do with it.
  }
  throw lastError;
}

function pruneJobs(jobs) {
  const sorted = [...jobs].sort((left, right) =>
    String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))
  );
  // Never drop a job that is still in play (queued/running/awaiting-approval).
  // Everything else competes for the MAX_JOBS budget.
  const inPlay = sorted.filter((job) => isInPlayStatus(job.status));
  const prunable = sorted.filter((job) => !isInPlayStatus(job.status));
  const room = Math.max(0, MAX_JOBS - inPlay.length);
  const keptPrunable = new Set(prunable.slice(0, room));
  return sorted.filter((job) => isInPlayStatus(job.status) || keptPrunable.has(job));
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

/**
 * Persist the index and delete the files of the jobs pruning just dropped.
 *
 * The deletion set is computed from the caller's own list, never from a fresh
 * read of the index: a job this writer never saw belongs to another process
 * and may well be queued or running. Diffing against a re-read index is how a
 * stale writer used to delete a concurrent worker's job file and revive
 * payload out from under it. Callers reach this through updateState, which
 * holds the lock and hands the mutator a fresh load.
 */
export function saveState(cwd, state) {
  ensureStateDir(cwd);
  const givenJobs = state.jobs ?? [];
  const nextJobs = pruneJobs(givenJobs);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of givenJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }

  writeFileAtomic(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`);
  return nextState;
}

/** Read-modify-write the state under the workspace lock. Every writer uses this. */
export function updateState(cwd, mutate) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    mutate(state);
    return saveState(cwd, state);
  });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  fs.writeFileSync(jobFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
