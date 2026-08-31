/**
 * Permission policy for Copilot sessions.
 *
 * The SDK asks the host to decide every privileged action through
 * `onPermissionRequest`. Upstream answered `approve-once` to everything, which
 * made `--write` decorative: a "read-only" review could still edit the tree.
 *
 * Two questions are asked of every request, in order:
 *
 *   1. Is the path inside the workspace? Decided here, by resolving it the way
 *      the filesystem would (see paths.mjs). The SDK's own "outside the
 *      sandbox" signal, `requestSandboxBypass`, is only ever set when a host
 *      configures a sandbox, which this plugin does not, so it cannot be the
 *      mechanism.
 *   2. Does the job's mode permit this kind of action?
 *
 * These are pure functions with no SDK import, so the policy is unit-testable
 * without a live Copilot runtime.
 */

import fs from "node:fs";

import { createWorkspacePolicy, isInsideWorkspace } from "./paths.mjs";

/** Review and diagnosis: Copilot may look, never touch. */
export const READ_ONLY = "read-only";
/** Rescue tasks: Copilot may edit the workspace it was pointed at. */
export const WORKSPACE_WRITE = "workspace-write";

export const PERMISSION_MODES = new Set([READ_ONLY, WORKSPACE_WRITE]);

/**
 * The one custom tool this plugin registers (see run-command.mjs). Declared
 * here so the policy can recognize it without importing the tool module.
 */
export const RUN_COMMAND_TOOL_NAME = "run_command";

/**
 * Paths inside the workspace that a delegated job must never write. Being
 * inside the fence is not enough: these run code on the user's behalf later
 * (hooks on the next commit, CI on the next push, tasks on the next editor
 * launch) or are git's own bookkeeping. Posix-relative; `X/**` covers X and
 * everything under it.
 */
export const PROTECTED_PATHS = Object.freeze([
  ".git",
  ".git/**",
  ".github/workflows/**",
  ".husky/**",
  ".vscode/tasks.json",
  // settings.json hooks run in the user's next Claude Code session.
  ".claude/**"
]);

const IS_WINDOWS = process.platform === "win32";

function protectedKey(text) {
  return IS_WINDOWS ? text.toLowerCase() : text;
}

/**
 * @param {string} relativePosix  Workspace-relative posix path ("" is the root).
 * @returns {{protected: boolean, pattern: string|null}}
 */
export function isProtectedPath(relativePosix) {
  if (typeof relativePosix !== "string" || relativePosix === "") {
    return { protected: false, pattern: null };
  }
  const rel = protectedKey(relativePosix);
  for (const pattern of PROTECTED_PATHS) {
    const key = protectedKey(pattern);
    if (key.endsWith("/**")) {
      const base = key.slice(0, -3);
      if (rel === base || rel.startsWith(`${base}/`)) {
        return { protected: true, pattern };
      }
    } else if (rel === key) {
      return { protected: true, pattern };
    }
  }
  return { protected: false, pattern: null };
}

/** Number of directory entries pointing at this file, or 0 when it is not a file. */
function hardlinkCount(resolvedPath) {
  try {
    const stat = fs.statSync(resolvedPath);
    return stat.isFile() ? stat.nlink : 0;
  } catch {
    return 0;
  }
}

const APPROVE = Object.freeze({ kind: "approve-once" });

function reject(reason) {
  return { kind: "reject", feedback: reason };
}

function allow(reason, file = null) {
  return { decision: APPROVE, allowed: true, reason, file };
}

function deny(reason) {
  return { decision: reject(reason), allowed: false, reason, file: null };
}

/**
 * Escalation is a deny at the wire level — a pending permission does not survive
 * a session disconnect, so it cannot be frozen and resumed. The `escalate: true`
 * flag is what tells the run loop to suspend the job into `awaiting-approval`
 * instead of letting it complete as a normal denial; on approval the session is
 * resumed and the model re-attempts the action, now allowed.
 */
function escalate(reason, file = null) {
  return { decision: reject(reason), allowed: false, escalate: true, reason, file };
}

/** Escalation trigger: a sentinel filename. */
export const ESCALATE_SENTINEL = process.env.COPILOT_ESCALATE_SENTINEL || "ESCALATE_ME.txt";

/**
 * Build a read-escalation predicate matching a sentinel basename. Swapping this
 * factory for a content-agnostic secret classifier is all it takes to escalate
 * secret-looking files instead; nothing else in the escalation machinery changes.
 *
 * @param {string} [sentinel]
 * @returns {(relativePosix: string) => boolean}
 */
export function makeSentinelEscalation(sentinel = ESCALATE_SENTINEL) {
  const target = protectedKey(sentinel);
  return (relativePosix) => {
    if (typeof relativePosix !== "string" || relativePosix === "") return false;
    const base = relativePosix.split("/").pop() ?? relativePosix;
    return protectedKey(base) === target;
  };
}

export function normalizeMode(mode) {
  if (mode === true) return WORKSPACE_WRITE;
  if (mode === false || mode == null) return READ_ONLY;
  const normalized = String(mode).trim().toLowerCase();
  return PERMISSION_MODES.has(normalized) ? normalized : READ_ONLY;
}

/**
 * Accept either a ready-made policy from createWorkspacePolicy or the loose
 * `{ workspaceRoot, cwd }` shape, defaulting to the process cwd.
 */
function resolvePolicy(policy) {
  if (policy && typeof policy === "object" && policy.rootCanonical) {
    return policy;
  }
  const root = policy?.workspaceRoot ?? policy?.cwd ?? process.cwd();
  return createWorkspacePolicy(root, policy?.cwd ?? root);
}

/** Why a path was judged outside, in words the model can act on. */
function outsideReason(check, policy) {
  if (check.error) {
    return `the path is invalid (${check.error})`;
  }
  return `it resolves to ${check.resolved}, outside the workspace ${policy.root}`;
}

/** Pseudo-devices a shell touches without touching the filesystem. */
function isDevicePath(candidate) {
  return typeof candidate === "string" && /^\/dev\//.test(candidate);
}

/**
 * Human-readable one-liner for a permission request, used in job logs so a
 * denial is traceable after the fact.
 */
export function describeRequest(request) {
  const kind = request?.kind ?? "unknown";
  switch (kind) {
    case "shell":
      return `shell: ${request.fullCommandText ?? "(no command text)"}`;
    case "write":
      return `write: ${request.fileName ?? "(no file)"}`;
    case "read":
      return `read: ${request.path ?? "(no path)"}`;
    case "url":
      return `url: ${request.url ?? "(no url)"}`;
    case "mcp":
      return `mcp: ${request.serverName ?? "?"}/${request.toolName ?? "?"}`;
    case "memory":
      return `memory: ${request.action ?? "store"}`;
    case "custom-tool":
      return `custom-tool: ${request.toolName ?? "?"}`;
    default:
      return kind;
  }
}

/**
 * Decide a single permission request.
 *
 * @param {object} request  SDK PermissionRequest (discriminated on `kind`).
 * @param {string} mode     READ_ONLY or WORKSPACE_WRITE.
 * @param {object} [policy] `{ workspaceRoot, cwd }` or a createWorkspacePolicy
 *                          result. Defaults to the process cwd. May carry
 *                          `escalateReads` / `approvedReads` (see escalate()).
 * @returns {{decision: object, allowed: boolean, reason: string, file: string|null, escalate?: boolean}}
 *   `file` is the workspace-relative posix path of an allowed read or write.
 *   `escalate` is true when the request was paused for the owner's decision.
 */
export function decidePermission(request, mode = READ_ONLY, policy = {}) {
  const effectiveMode = normalizeMode(mode);
  const kind = request?.kind;
  const workspace = resolvePolicy(policy);

  // Escalation config is read from the raw policy arg, not the resolved
  // workspace: when the policy is a loose {workspaceRoot, cwd, ...} shape,
  // resolvePolicy rebuilds a bare workspace and would drop these.
  const escalateReads = typeof policy?.escalateReads === "function" ? policy.escalateReads : null;
  const approvedReads =
    policy?.approvedReads instanceof Set
      ? policy.approvedReads
      : Array.isArray(policy?.approvedReads)
        ? new Set(policy.approvedReads)
        : null;

  // The SDK sets this only when a host configures `sandbox.allowBypass`, which
  // we never do, so in practice it never arrives. Kept as defense in depth:
  // if a runtime ever does ask, the answer is still no, in either mode.
  if (request?.requestSandboxBypass) {
    return deny(
      `Sandbox bypass denied. This job is scoped to its workspace. Reason given: ${
        request.requestSandboxBypassReason ?? "none"
      }`
    );
  }

  switch (kind) {
    case "read": {
      // Reads outside the workspace are refused in both modes: a read-only job
      // would leak the contents into the transcript; a write job, with network
      // access open, can send them anywhere.
      const check = isInsideWorkspace(workspace, request.path, { cwd: workspace.cwd });
      if (!check.inside) {
        return deny(
          `Refused to read ${request.path ?? "a file"}: ${outsideReason(
            check,
            workspace
          )}. Include the file in the prompt or run the job from a directory that contains it.`
        );
      }
      // Inside the fence, one more gate for reads the owner asked to be consulted
      // on (a sentinel today, secret-looking files later). A path the owner
      // already approved in a prior escalation is allowed straight through.
      if (approvedReads && approvedReads.has(check.relative)) {
        return allow("Read approved by the owner.", check.relative);
      }
      if (escalateReads && escalateReads(check.relative)) {
        return escalate(
          `Reading ${check.relative} needs the owner's approval. The job is paused; run \`/copilot:approve\` to allow it or \`/copilot:deny\` to refuse.`,
          check.relative
        );
      }
      return allow("Read inside the workspace.", check.relative);
    }

    case "write": {
      // Containment first, in both modes, so the denial names the real
      // problem instead of hiding it behind "read-only".
      const check = isInsideWorkspace(workspace, request.fileName, { cwd: workspace.cwd });
      if (!check.inside) {
        return deny(`Refused to write ${request.fileName ?? "a file"}: ${outsideReason(check, workspace)}.`);
      }
      // Inside the fence is not the whole story. Some paths run code later on
      // the user's behalf, and a hardlink lets a write land in a file that
      // lives somewhere else entirely. Both are refused in both modes.
      const protection = isProtectedPath(check.relative);
      if (protection.protected) {
        return deny(
          `Refused to write ${request.fileName}: ${check.relative} is a protected path (${protection.pattern}); hooks, CI workflows and git metadata are off limits to delegated jobs.`
        );
      }
      const links = hardlinkCount(check.resolved);
      if (links > 1) {
        return deny(
          `Refused to write ${request.fileName}: it is hardlinked to another location (${links} links); editing it would change a file outside this path.`
        );
      }
      return effectiveMode === WORKSPACE_WRITE
        ? allow("Write mode is enabled for this job.", check.relative)
        : deny(
            `Refused to write ${
              request.fileName ?? "a file"
            }: this job is read-only. Report the change as a suggested diff instead of applying it.`
          );
    }

    case "shell": {
      // The runtime extracts the paths a command may touch. This is not a
      // sandbox: a command that hides its target from the extractor still
      // runs. But when the runtime does name a path outside the workspace,
      // refuse it, in both modes.
      const possiblePaths = Array.isArray(request.possiblePaths) ? request.possiblePaths : [];
      for (const candidate of possiblePaths) {
        if (isDevicePath(candidate)) continue;
        const check = isInsideWorkspace(workspace, candidate, { cwd: workspace.cwd });
        if (!check.inside) {
          return deny(
            `Refused \`${request.fullCommandText}\`: it references ${candidate}, ${outsideReason(
              check,
              workspace
            )}.`
          );
        }
      }

      // The runtime classifies each parsed command; trust that over any
      // allowlist we could write ourselves, since it understands chaining.
      const commands = Array.isArray(request.commands) ? request.commands : [];
      const mutating = commands.filter((command) => command?.readOnly !== true);

      if (effectiveMode === WORKSPACE_WRITE) {
        return allow("Write mode is enabled for this job.");
      }
      if (request.hasWriteFileRedirection) {
        return deny(
          `Refused \`${request.fullCommandText}\`: it redirects output to a file and this job is read-only.`
        );
      }
      if (mutating.length > 0) {
        const names = mutating.map((command) => command.identifier ?? "?").join(", ");
        return deny(
          `Refused \`${request.fullCommandText}\`: ${names} can modify state and this job is read-only.`
        );
      }
      if (commands.length === 0) {
        return deny(
          `Refused \`${request.fullCommandText}\`: the runtime could not classify it as read-only.`
        );
      }
      return allow("All parsed commands are read-only.");
    }

    case "url":
      // Fetching docs is reasonable while implementing; while reviewing a diff
      // it is not, and it is the cheapest exfiltration path available.
      return effectiveMode === WORKSPACE_WRITE
        ? allow("Write mode is enabled for this job.")
        : deny(`Refused to fetch ${request.url ?? "a URL"}: this job is read-only and offline.`);

    case "mcp":
      if (request.readOnly === true) {
        return allow("MCP tool is declared read-only.");
      }
      return effectiveMode === WORKSPACE_WRITE
        ? allow("Write mode is enabled for this job.")
        : deny(
            `Refused MCP tool ${request.serverName ?? "?"}/${
              request.toolName ?? "?"
            }: it is not read-only and this job is read-only.`
          );

    case "custom-tool":
      // The CLI asks about custom tools that were registered without
      // `skipPermission`. Ours sets it, because run_command decides inside its
      // own handler; this branch is belt and braces for any other host tool.
      return request.toolName === RUN_COMMAND_TOOL_NAME
        ? allow(`${RUN_COMMAND_TOOL_NAME} enforces its own policy.`)
        : deny(`Refused custom tool ${request.toolName ?? "?"}: not registered by this plugin.`);

    case "memory":
      // Persisted across sessions and invisible in the job output. A delegated
      // job should never quietly rewrite the user's Copilot memory.
      return deny("Refused to write to Copilot memory: delegated jobs do not persist memories.");

    default:
      // Unknown kinds are refused rather than approved. New privileged request
      // types should fail closed until this policy is taught about them.
      return deny(`Refused an unrecognized permission request (${kind ?? "no kind"}).`);
  }
}

/**
 * Build the `onPermissionRequest` handler the SDK expects.
 *
 * @param {string} mode          READ_ONLY or WORKSPACE_WRITE.
 * @param {(entry: object) => void} [onDecision]  Observer for logging.
 * @param {{
 *   workspaceRoot?: string,
 *   cwd?: string,
 *   escalateReads?: (relativePosix: string) => boolean,
 *   approvedReads?: Set<string>|string[]
 * }} [scope]
 *   Containment root (the git top level) and the directory relative paths
 *   resolve against. Both default to the process cwd.
 */
export function createPermissionHandler(mode, onDecision, scope = {}) {
  const effectiveMode = normalizeMode(mode);
  const root = scope.workspaceRoot ?? scope.cwd ?? process.cwd();
  const workspace = createWorkspacePolicy(root, scope.cwd ?? root);
  // Carry the escalation config on the same policy object. resolvePolicy and
  // isInsideWorkspace both pass a policy with `rootCanonical` through unchanged,
  // so the extra fields survive to decidePermission.
  /** @type {Record<string, any>} */
  const policy = { ...workspace };
  if (typeof scope.escalateReads === "function") policy.escalateReads = scope.escalateReads;
  if (scope.approvedReads) policy.approvedReads = scope.approvedReads;

  return (request) => {
    const { decision, allowed, reason, file, escalate: escalated } = decidePermission(
      request,
      effectiveMode,
      policy
    );
    onDecision?.({
      allowed,
      reason,
      mode: effectiveMode,
      request: describeRequest(request),
      kind: request?.kind ?? "unknown",
      // Workspace-relative posix path of an allowed read or write, null
      // otherwise. The `request` string above is display text, not something
      // to parse back.
      file,
      // True when the request was flagged for the owner's decision; the run loop
      // uses this to suspend the job instead of treating it as a plain denial.
      escalate: escalated === true
    });
    return decision;
  };
}
