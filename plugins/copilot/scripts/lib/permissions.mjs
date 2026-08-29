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

import { createWorkspacePolicy, isInsideWorkspace } from "./paths.mjs";

/** Review and diagnosis: Copilot may look, never touch. */
export const READ_ONLY = "read-only";
/** Rescue tasks: Copilot may edit the workspace it was pointed at. */
export const WORKSPACE_WRITE = "workspace-write";

export const PERMISSION_MODES = new Set([READ_ONLY, WORKSPACE_WRITE]);

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
 *                          result. Defaults to the process cwd.
 * @returns {{decision: object, allowed: boolean, reason: string, file: string|null}}
 *   `file` is the workspace-relative posix path of an allowed read or write.
 */
export function decidePermission(request, mode = READ_ONLY, policy = {}) {
  const effectiveMode = normalizeMode(mode);
  const kind = request?.kind;
  const workspace = resolvePolicy(policy);

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
      // Denied in both modes. A read-only job would leak the contents into the
      // transcript; a write job, with network access open, can send them
      // anywhere. Neither is what "review this repo" means.
      const check = isInsideWorkspace(workspace, request.path, { cwd: workspace.cwd });
      if (!check.inside) {
        return deny(
          `Refused to read ${request.path ?? "a file"}: ${outsideReason(
            check,
            workspace
          )}. Include the file in the prompt or run the job from a directory that contains it.`
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
 * @param {{workspaceRoot?: string, cwd?: string}} [scope]
 *   Containment root (the git top level) and the directory relative paths
 *   resolve against. Both default to the process cwd.
 */
export function createPermissionHandler(mode, onDecision, scope = {}) {
  const effectiveMode = normalizeMode(mode);
  const root = scope.workspaceRoot ?? scope.cwd ?? process.cwd();
  const workspace = createWorkspacePolicy(root, scope.cwd ?? root);

  return (request) => {
    const { decision, allowed, reason, file } = decidePermission(request, effectiveMode, workspace);
    onDecision?.({
      allowed,
      reason,
      mode: effectiveMode,
      request: describeRequest(request),
      kind: request?.kind ?? "unknown",
      // Workspace-relative posix path of an allowed read or write, null
      // otherwise. The `request` string above is display text, not something
      // to parse back.
      file
    });
    return decision;
  };
}
