/**
 * MCP tool definitions for the Copilot plugin.
 *
 * Each tool maps to a subcommand of the CLI (`bin/copilot-plugin.mjs`). The MCP
 * server (bin/copilot-mcp.mjs) spawns that CLI and returns its output, so every
 * tool reuses the exact logic the Claude Code side already runs and tests —
 * argument policy, the permission handler, background workers, the approval
 * flow, state on disk — with nothing re-implemented here.
 *
 * `inputSchema` is plain JSON Schema (no zod). `toArgv(args)` turns the tool's
 * arguments into the CLI argv; `cwd` is handled by the server, not here.
 */

/** A workspace path argument every tool accepts; the server resolves the cwd from it. */
const PATH_PROP = {
  path: {
    type: "string",
    description: "Absolute path to the repository or a directory inside it. Defaults to the server's working directory."
  }
};

const MODEL_PROPS = {
  model: { type: "string", description: "Model id or alias (opus, sonnet, codex, gemini). Omit for the account default." },
  effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"], description: "Reasoning effort, for models that support it." }
};

const REVIEW_PROPS = {
  ...PATH_PROP,
  base: { type: "string", description: "Review the branch diff against this ref instead of the working tree." },
  scope: { type: "string", enum: ["auto", "working-tree", "branch"], description: "What to review. Default: auto." },
  ...MODEL_PROPS
};

function flag(name, value) {
  return value ? [name] : [];
}

function opt(name, value) {
  return value === undefined || value === null || value === "" ? [] : [name, String(value)];
}

/**
 * The env var that lets an MCP client start a write job.
 *
 * Claude Code forbids its rescue command and agent from adding --write on
 * their own; the user has to type it. MCP has no equivalent channel -- the
 * arguments come from the model, and the host confirms the call, not the
 * privilege inside it. So the opt-in lives in the server's environment, which
 * only the user edits (mcp.json), and the model cannot set.
 */
export const ALLOW_WRITE_ENV = "COPILOT_MCP_ALLOW_WRITE";

/** @type {Array<{name: string, description: string, inputSchema: object, toArgv: (args: object) => string[], guard?: (args: object, env: object) => string|null}>} */
export const TOOLS = [
  {
    name: "copilot_review",
    description:
      "Non-mutating Copilot review of your uncommitted changes or your branch: it may read the repository and run its commands (tests, linters) to check its conclusions, and can never write. Returns findings ordered by severity. Blocks until the review finishes. Exit status 2 means the run was degraded -- something it asked for was refused -- and its verdict is not trustworthy.",
    inputSchema: { type: "object", properties: REVIEW_PROPS },
    toArgv: (a) => ["review", ...opt("--base", a.base), ...opt("--scope", a.scope), ...opt("--model", a.model), ...opt("--effort", a.effort)]
  },
  {
    name: "copilot_adversarial_review",
    description:
      "Non-mutating Copilot review that challenges the design, not just the code: auth, data loss, rollback safety, races, version skew. May run the repository's commands, never writes. Takes optional free-text focus.",
    inputSchema: {
      type: "object",
      properties: { ...REVIEW_PROPS, focus: { type: "string", description: "What to weight the review toward." } }
    },
    toArgv: (a) => [
      "adversarial-review",
      ...opt("--base", a.base),
      ...opt("--scope", a.scope),
      ...opt("--model", a.model),
      ...opt("--effort", a.effort),
      ...(a.focus ? [String(a.focus)] : [])
    ]
  },
  {
    name: "copilot_rescue",
    description:
      "Hand a task to Copilot: investigate, diagnose, or fix. Read-only unless `write` is true, which the repository owner must enable in the server environment. Use `background: true` for long tasks and poll copilot_status / copilot_result.",
    inputSchema: {
      type: "object",
      properties: {
        ...PATH_PROP,
        prompt: { type: "string", description: "What Copilot should do." },
        write: {
          type: "boolean",
          description: `Allow Copilot to edit files. Default false (reports a diff instead). Refused unless ${ALLOW_WRITE_ENV}=1 is set in this server's environment.`
        },
        background: { type: "boolean", description: "Run detached and return a job id instead of blocking." },
        resume: { type: "boolean", description: "Continue the latest rescue thread for this repository." },
        ...MODEL_PROPS
      }
    },
    // --unsafe-shell and --allow-wide-root are deliberately absent: they are
    // the two flags that widen a job past its workspace, and nothing here can
    // tell a user asking for them from a prompt injection asking for them.
    // The CLI still has both for someone typing at a terminal.
    toArgv: (a) => [
      "task",
      ...flag("--write", a.write),
      ...flag("--background", a.background),
      ...flag("--resume-last", a.resume),
      ...opt("--model", a.model),
      ...opt("--effort", a.effort),
      ...(a.prompt ? [String(a.prompt)] : [])
    ],
    guard: (a, env) =>
      a.write && env?.[ALLOW_WRITE_ENV] !== "1"
        ? `A write task is not enabled for this MCP server. The repository owner can allow it by setting ${ALLOW_WRITE_ENV}=1 in the server's "env" block in mcp.json, then reloading. Without it, run the task read-only and apply the diff yourself.`
        : null
  },
  {
    name: "copilot_status",
    description: "Running, paused and recent Copilot jobs for this repository. Pass a job id for one job, or all=true for every session's jobs.",
    inputSchema: {
      type: "object",
      properties: { ...PATH_PROP, job_id: { type: "string" }, all: { type: "boolean" } }
    },
    toArgv: (a) => ["status", ...(a.job_id ? [String(a.job_id)] : []), ...flag("--all", a.all)]
  },
  {
    name: "copilot_result",
    description: "The stored final output of a finished Copilot job. Defaults to the latest finished job.",
    inputSchema: { type: "object", properties: { ...PATH_PROP, job_id: { type: "string" } } },
    toArgv: (a) => ["result", ...(a.job_id ? [String(a.job_id)] : [])]
  },
  {
    name: "copilot_approve",
    description: "Approve a Copilot job that paused waiting for your permission; it resumes in the background.",
    inputSchema: { type: "object", properties: { ...PATH_PROP, job_id: { type: "string" } } },
    toArgv: (a) => ["approve", ...(a.job_id ? [String(a.job_id)] : [])]
  },
  {
    name: "copilot_deny",
    description: "Deny a Copilot job that paused waiting for your permission; it closes without continuing.",
    inputSchema: { type: "object", properties: { ...PATH_PROP, job_id: { type: "string" } } },
    toArgv: (a) => ["deny", ...(a.job_id ? [String(a.job_id)] : [])]
  },
  {
    name: "copilot_cancel",
    description: "Stop a running or paused Copilot job.",
    inputSchema: { type: "object", properties: { ...PATH_PROP, job_id: { type: "string" } } },
    toArgv: (a) => ["cancel", ...(a.job_id ? [String(a.job_id)] : [])]
  },
  {
    name: "copilot_setup",
    description: "Report whether the Copilot runtime is installed and authenticated. Pass install_runtime=true to install it.",
    inputSchema: { type: "object", properties: { ...PATH_PROP, install_runtime: { type: "boolean" } } },
    toArgv: (a) => ["setup", ...flag("--install-runtime", a.install_runtime)]
  }
];

/** Tool listing shape for the MCP `tools/list` response. */
export function toolDefinitions() {
  return TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

/** Look up a tool by name. */
export function findTool(name) {
  return TOOLS.find((tool) => tool.name === name) ?? null;
}
