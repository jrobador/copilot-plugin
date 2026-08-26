/**
 * Permission policy for Copilot sessions.
 *
 * The SDK asks the host to decide every privileged action through
 * `onPermissionRequest`. Upstream answered `approve-once` to everything, which
 * made `--write` decorative: a "read-only" review could still edit the tree.
 *
 * These are pure functions with no SDK import, so the policy is unit-testable
 * without a live Copilot runtime.
 */

/** Review and diagnosis: Copilot may look, never touch. */
export const READ_ONLY = "read-only";
/** Rescue tasks: Copilot may edit the workspace it was pointed at. */
export const WORKSPACE_WRITE = "workspace-write";

export const PERMISSION_MODES = new Set([READ_ONLY, WORKSPACE_WRITE]);

const APPROVE = Object.freeze({ kind: "approve-once" });

function reject(reason) {
  return { kind: "reject", feedback: reason };
}

function allow(reason) {
  return { decision: APPROVE, allowed: true, reason };
}

function deny(reason) {
  return { decision: reject(reason), allowed: false, reason };
}

export function normalizeMode(mode) {
  if (mode === true) return WORKSPACE_WRITE;
  if (mode === false || mode == null) return READ_ONLY;
  const normalized = String(mode).trim().toLowerCase();
  return PERMISSION_MODES.has(normalized) ? normalized : READ_ONLY;
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
 * @returns {{decision: object, allowed: boolean, reason: string}}
 */
export function decidePermission(request, mode = READ_ONLY) {
  const effectiveMode = normalizeMode(mode);
  const kind = request?.kind;

  // A sandbox bypass is a request to act outside the workspace the job was
  // scoped to. Never granted automatically, in either mode.
  if (request?.requestSandboxBypass) {
    return deny(
      `Sandbox bypass denied. This job is scoped to its workspace. Reason given: ${
        request.requestSandboxBypassReason ?? "none"
      }`
    );
  }

  switch (kind) {
    case "read":
      return allow("Reads are always permitted.");

    case "write":
      return effectiveMode === WORKSPACE_WRITE
        ? allow("Write mode is enabled for this job.")
        : deny(
            `Refused to write ${
              request.fileName ?? "a file"
            }: this job is read-only. Report the change as a suggested diff instead of applying it.`
          );

    case "shell": {
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
 */
export function createPermissionHandler(mode, onDecision) {
  const effectiveMode = normalizeMode(mode);
  return (request) => {
    const { decision, allowed, reason } = decidePermission(request, effectiveMode);
    onDecision?.({
      allowed,
      reason,
      mode: effectiveMode,
      request: describeRequest(request),
      kind: request?.kind ?? "unknown"
    });
    return decision;
  };
}
