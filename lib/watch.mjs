// What `watch` prints while a job runs: only the lines a person watching it
// would act on. A job used to be a black box until it finished or hit the
// turn timeout; the log already held every command and refusal, but nothing
// surfaced it while there was still time to cancel.

import { AWAITING_APPROVAL } from "./state.mjs";

const LOG_PREFIX = /^\[[^\]]+\]\s*(.*)$/;

/**
 * One log line to one watch event, or null when the line is noise.
 *
 *   CMD     a command Copilot ran, with its exit code
 *   DENIED  a request the fence refused, or the owner denied
 *   PAUSED  a request escalated to the owner; the job is about to stop
 */
export function classifyLogLine(line) {
  const match = LOG_PREFIX.exec(String(line).trimEnd());
  if (!match) {
    return null;
  }
  const text = match[1].replace(/\.$/, "");
  if (text.startsWith("Ran ")) {
    return `CMD ${text.slice("Ran ".length)}`;
  }
  if (text.startsWith("Denied ")) {
    return `DENIED ${text.slice("Denied ".length)}`;
  }
  if (text.startsWith("Paused for approval: ")) {
    return `PAUSED ${text.slice("Paused for approval: ".length)}`;
  }
  return null;
}

/** Split off the trailing partial line, which the next read completes. */
export function splitCompleteLines(text) {
  const parts = String(text).split(/\r?\n/);
  const rest = parts.pop() ?? "";
  return { lines: parts, rest };
}

/** The tail of the running narration, on one line. */
export function latestNarration(partialOutput, maxChars = 160) {
  const flat = String(partialOutput ?? "").replace(/\s+/g, " ").trim();
  if (flat.length <= maxChars) {
    return flat;
  }
  return `...${flat.slice(-maxChars)}`;
}

export function formatMinutes(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60000));
  return `${minutes}m`;
}

/** The last line `watch` prints, with the command that comes next. */
export function renderEndLine(job) {
  const parts = [`END status=${job.status}`];
  if (job.deniedCount) {
    parts.push(`denied=${job.deniedCount}`);
  }
  if (job.errorMessage) {
    parts.push(`error=${String(job.errorMessage).replace(/\s+/g, " ")}`);
  }
  if (job.status === AWAITING_APPROVAL) {
    parts.push(`request=${job.pendingApproval?.request ?? "unknown"}`);
    parts.push(`next: approve ${job.id} or deny ${job.id}`);
  } else {
    parts.push(`next: result ${job.id}`);
  }
  return parts.join(" | ");
}
