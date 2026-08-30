/**
 * Thin wrapper over @github/copilot-sdk.
 *
 * The SDK drives the Copilot CLI over JSON-RPC, which is the same shape as the
 * `codex app-server` the Codex plugin talks to. One client per workspace root;
 * sessions are created against it.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { binaryAvailable } from "./process.mjs";
import { createWorkspacePolicy } from "./paths.mjs";
import { ROOT_DIR } from "./plugin-root.mjs";
import { createPermissionHandler, normalizeMode, READ_ONLY, WORKSPACE_WRITE } from "./permissions.mjs";
import { createRunCommandTool, SHELL_TOOL_NAMES } from "./run-command.mjs";

const SESSION_ID_ENV = "COPILOT_COMPANION_SESSION_ID";
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";
const TASK_SESSION_PREFIX = "Copilot Companion Task";
const CLIENT_NAME = "copilot-plugin-cc";

/**
 * The SDK's sendAndWait default is 60s, which a multi-file review blows through
 * long before it finishes. The timeout only stops us waiting -- it does not
 * abort the agent -- so a short one strands work that is still running.
 */
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000;

const MODE = Symbol("permissionMode");

/** Routes permission decisions into the turn currently running on a session. */
export const DECISION_SINK = Symbol.for("copilot-plugin-cc.decisionSink");

/** One client per working directory. The SDK spawns a CLI process per client. */
const clients = new Map();

function shorten(text, limit = 72) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) return "";
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 3)}...`;
}

/**
 * Test seam: a module path that stands in for @github/copilot-sdk. It must
 * export `CopilotClient` with the same surface. Lets the whole CLI run against
 * tests/fake-copilot-fixture.mjs in a spawned process, without a Copilot login.
 */
export const SDK_MODULE_ENV = "COPILOT_COMPANION_SDK_MODULE";

function sdkOverride() {
  const override = process.env[SDK_MODULE_ENV];
  return override && override.trim() ? override.trim() : null;
}

export const SDK_PACKAGE = "@github/copilot-sdk";

/** The one remediation for a missing runtime, used everywhere it is mentioned. */
export const SDK_INSTALL_HINT = "Run `/copilot:setup --install-runtime` to install the Copilot runtime into the plugin directory.";

/**
 * How the runtime gets installed: into the plugin directory itself, next to
 * the scripts that import it. The marketplace copies plugins/copilot and
 * nothing else, so the repository's node_modules is never on the resolution
 * path of an installed plugin; this is. Constant arguments only -- it is the
 * one command that may go through cmd.exe (npm's .cmd shim).
 *
 * Run with cwd = ROOT_DIR, not `--prefix`: npm invoked from inside another
 * package with `--prefix` adds that package as a `file:` dependency of the
 * target, which is exactly the repository-to-plugin link this must not create.
 */
export function sdkInstallCommand() {
  return { command: "npm", args: ["install", "--omit=dev", "--no-audit", "--no-fund"], cwd: ROOT_DIR };
}

/**
 * Where the runtime is, or why it is not. `available` is what every caller
 * needs; the rest is for `/copilot:setup` to print.
 */
export function getSdkStatus() {
  const override = sdkOverride();
  if (override) {
    return {
      available: true,
      version: null,
      installDir: null,
      source: "override",
      detail: `fake runtime (${SDK_MODULE_ENV}=${override})`,
      installCommand: null
    };
  }
  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve(SDK_PACKAGE);
    // Walk up from the entry point to the package's own manifest; the package
    // may not export ./package.json, so it cannot be required by name.
    let dir = path.dirname(entry);
    for (;;) {
      const manifestPath = path.join(dir, "package.json");
      if (fsExists(manifestPath)) {
        const manifest = require(manifestPath);
        if (manifest.name === SDK_PACKAGE) {
          return {
            available: true,
            version: manifest.version ?? null,
            installDir: dir,
            source: "installed",
            detail: `${SDK_PACKAGE} ${manifest.version ?? "?"} in ${dir}`,
            installCommand: null
          };
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return { available: true, version: null, installDir: null, source: "installed", detail: `${SDK_PACKAGE} resolved from ${entry}`, installCommand: null };
  } catch (error) {
    return {
      available: false,
      version: null,
      installDir: null,
      source: null,
      detail: `not installed (${error.message.split("\n")[0]})`,
      installCommand: sdkInstallCommand()
    };
  }
}

function fsExists(file) {
  try {
    return createRequire(import.meta.url)("node:fs").existsSync(file);
  } catch {
    return false;
  }
}

async function loadSdk() {
  const override = sdkOverride();
  if (override) {
    try {
      return await import(pathToFileURL(path.resolve(override)).href);
    } catch (error) {
      throw Object.assign(new Error(`${SDK_MODULE_ENV} points at ${override}, which could not be loaded (${error.message})`), {
        code: "SDK_MISSING"
      });
    }
  }
  try {
    return await import(SDK_PACKAGE);
  } catch (error) {
    throw Object.assign(new Error(`The Copilot runtime (${SDK_PACKAGE}) is not installed. ${SDK_INSTALL_HINT} (${error.message})`), {
      code: "SDK_MISSING"
    });
  }
}

export async function ensureClient(cwd = process.cwd(), options = {}) {
  const existing = clients.get(cwd);
  if (existing) return existing;

  const { CopilotClient } = await loadSdk();
  const client = new CopilotClient({
    workingDirectory: cwd,
    logLevel: options.logLevel ?? "error"
  });
  await client.start();
  clients.set(cwd, client);
  return client;
}

export async function shutdownClient(cwd) {
  const keys = cwd ? [cwd] : [...clients.keys()];
  for (const key of keys) {
    const client = clients.get(key);
    if (!client) continue;
    clients.delete(key);
    try {
      await client.stop();
    } catch {
      await client.forceStop?.().catch(() => {});
    }
  }
}

export function buildSessionConfig(options, permissionMode, sink) {
  const cwd = options.cwd ?? process.cwd();
  // Every read, write and command argument is judged against this root. The
  // git top level when there is one, so a job started in a sub-package can
  // still reach its siblings; the cwd itself otherwise.
  const workspaceRoot = options.workspaceRoot ?? cwd;
  const policy = createWorkspacePolicy(workspaceRoot, cwd);
  // The handler is bound once, at session creation, but each turn needs its
  // own record of what was denied. `sink.current` is swapped per turn by
  // runPrompt, so the long-lived handler always reaches the running turn.
  const observe = (entry) => {
    options.onPermissionDecision?.(entry);
    sink.current?.(entry);
  };

  const config = {
    clientName: CLIENT_NAME,
    onPermissionRequest: createPermissionHandler(permissionMode, observe, {
      workspaceRoot,
      cwd,
      // Reads the owner wants to be consulted on (v1: a sentinel predicate),
      // and reads a prior escalation already approved. Both optional.
      escalateReads: options.escalateReads,
      approvedReads: options.approvedReads
    }),
    // Touched files are reported back to the user, so track them.
    enableFileChangeTracking: permissionMode === WORKSPACE_WRITE,
    // The runtime's shell tools hand the model an interpreter we cannot
    // fence. run_command spawns one program with an argument list instead,
    // and reports through the same observer as the permission handler.
    tools: [
      createRunCommandTool({
        mode: permissionMode,
        policy,
        config: { extraPrograms: options.extraPrograms ?? [] },
        onDecision: observe
      })
    ]
  };

  const excluded = new Set(Array.isArray(options.excludedTools) ? options.excludedTools : []);
  if (options.unsafeShell !== true) {
    for (const name of SHELL_TOOL_NAMES) excluded.add(name);
  }
  if (excluded.size > 0) config.excludedTools = [...excluded];

  if (options.model) config.model = options.model;
  if (options.reasoningEffort) config.reasoningEffort = options.reasoningEffort;
  if (options.systemMessage) config.systemMessage = options.systemMessage;
  if (options.availableTools) config.availableTools = options.availableTools;

  return config;
}

/**
 * @param {object} options
 * @param {string} [options.cwd]              Directory the session runs in.
 * @param {string} [options.workspaceRoot]    Containment root for the permission
 *                                            policy (the git top level); defaults to cwd.
 * @param {boolean} [options.unsafeShell]     Keep the runtime's own shell tools. Off by
 *                                            default: run_command replaces them.
 * @param {string[]} [options.extraPrograms]  Extra programs run_command may spawn in
 *                                            write mode (from `setup --allow-programs`).
 * @param {string} [options.model]            Model id; see listModels().
 * @param {string} [options.reasoningEffort]  Only for models that support it.
 * @param {string} [options.sessionId]        Set to make the session resumable.
 * @param {string} [options.permissionMode]   READ_ONLY (default) or WORKSPACE_WRITE.
 * @param {Function} [options.onPermissionDecision]  Observer for allow/deny logging.
 * @param {string} [options.systemMessage]    Appended to the runtime's system prompt.
 * @param {string[]} [options.availableTools]
 * @param {string[]} [options.excludedTools]
 * @param {(relativePosix: string) => boolean} [options.escalateReads]
 *   Reads the owner wants to be consulted on; see permissions.mjs.
 * @param {Set<string>|string[]} [options.approvedReads]
 *   Reads a prior escalation already approved.
 * @param {boolean} [options.allowFreshFallback]
 *   resumeSession only: false makes a missing session report `resumed: false`
 *   with no session instead of starting a fresh one.
 * @param {string} [options.logLevel]
 */
export async function createSession(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const permissionMode = normalizeMode(options.permissionMode);
  const client = await ensureClient(cwd, options);

  const sink = { current: null };
  const config = buildSessionConfig(options, permissionMode, sink);
  if (options.sessionId) config.sessionId = options.sessionId;

  const session = await client.createSession(config);
  session[MODE] = permissionMode;
  session[DECISION_SINK] = sink;
  return session;
}

/**
 * Resume a previous session by id, falling back to a fresh one when the id is
 * unknown (the CLI prunes old session state).
 */
export async function resumeSession(sessionId, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const permissionMode = normalizeMode(options.permissionMode);
  const client = await ensureClient(cwd, options);

  const sink = { current: null };
  try {
    const session = await client.resumeSession(
      sessionId,
      buildSessionConfig(options, permissionMode, sink)
    );
    session[MODE] = permissionMode;
    session[DECISION_SINK] = sink;
    return { session, resumed: true };
  } catch {
    // The CLI prunes old session state. A `--resume-last` continuation is happy
    // with a fresh session, but an approval-resume must NOT restart from scratch
    // (it would lose the frozen context and silently re-run the whole task), so
    // callers that require the original context pass allowFreshFallback:false
    // and treat resumed:false as "expired".
    if (options.allowFreshFallback === false) {
      return { session: null, resumed: false, previousId: sessionId };
    }
    // A fresh session gets a fresh id. Reusing the one that failed to resume
    // would name the new conversation after the old one and hide the fallback
    // from every later lookup.
    const session = await createSession({ ...options, cwd, permissionMode, sessionId: undefined });
    return { session, resumed: false, previousId: sessionId };
  }
}

/** The id of the most recent session the CLI recorded, or null. */
export async function getLastSessionId(cwd = process.cwd()) {
  try {
    const client = await ensureClient(cwd);
    return (await client.getLastSessionId()) ?? null;
  } catch {
    return null;
  }
}

/**
 * Send one prompt and wait for the turn to finish, streaming progress out.
 *
 * `session.on()` returns an unsubscribe function; it is called on the way out
 * so a resumed session does not accumulate a listener per turn.
 */
export async function runPrompt(session, prompt, options = {}) {
  const { onProgress, attachments, agentMode, timeout } = options;
  const chunks = [];
  const reasoning = [];
  const toolCalls = [];
  const denials = [];
  const touchedFiles = new Set();
  // First permission the policy flagged for the owner's decision. Its presence
  // is what turns a finished turn into an `awaiting-approval` job.
  let pendingApproval = null;
  // tool.execution_complete carries only a toolCallId, never the tool name,
  // so remember what each id was called when it started.
  const toolNames = new Map();

  const unsubscribe = session.on((event) => {
    const eventType = event.type?.value ?? event.type;
    switch (eventType) {
      case "assistant.message_delta":
        chunks.push(event.data.deltaContent || "");
        break;
      case "assistant.reasoning_delta":
        reasoning.push(event.data.deltaContent || "");
        break;
      case "tool.execution_start": {
        const name = event.data.toolName;
        toolCalls.push(name);
        toolNames.set(event.data.toolCallId, name);
        onProgress?.({
          message: `Running tool: ${name}.`,
          phase: "investigating",
          stderrMessage: `Running tool: ${name}`,
          logTitle: null,
          logBody: null
        });
        break;
      }
      case "tool.execution_complete": {
        const name = toolNames.get(event.data.toolCallId) ?? "tool";
        toolNames.delete(event.data.toolCallId);
        const status = event.data.success ? "completed" : "failed";
        onProgress?.({
          message: `Tool ${name} ${status}.`,
          phase: "running",
          stderrMessage: `Tool ${name} ${status}`,
          logTitle: null,
          logBody: null
        });
        break;
      }
      case "session.idle":
        onProgress?.({
          message: "Turn completed.",
          phase: "finalizing",
          stderrMessage: null,
          logTitle: null,
          logBody: null
        });
        break;
      default:
        break;
    }
  });

  // The permission handler was bound at session creation; route its decisions
  // into this turn's record so denials surface in the job output.
  const sink = session[DECISION_SINK] ?? { current: null };
  const previousSink = sink.current;
  sink.current = (entry) => {
    if (entry.escalate) {
      // Denied at the wire this turn, but recorded so the job suspends into
      // awaiting-approval instead of finishing as a plain denial. First wins.
      if (!pendingApproval) {
        pendingApproval = {
          kind: entry.kind,
          file: entry.file ?? null,
          reason: entry.reason,
          request: entry.request
        };
      }
      onProgress?.({
        message: `Paused for approval: ${entry.request}.`,
        phase: "running",
        stderrMessage: `Escalated ${entry.request}`,
        logTitle: "Awaiting approval",
        logBody: entry.reason
      });
      return;
    }
    if (entry.allowed) {
      if (entry.kind === "write" && entry.file) {
        touchedFiles.add(entry.file);
      }
      if (entry.kind === "command") {
        const exit = entry.detail?.timedOut ? "timeout" : (entry.detail?.exitCode ?? "?");
        onProgress?.({
          message: `Ran ${entry.request}.`,
          phase: "running",
          stderrMessage: `Ran ${entry.request} (exit ${exit})`,
          logTitle: `Command (exit ${exit})`,
          logBody: entry.detail?.preview || null
        });
      }
      return;
    }
    denials.push(entry);
    onProgress?.({
      message: `Denied ${entry.kind} request.`,
      phase: "running",
      stderrMessage: `Denied ${entry.request} (${entry.mode})`,
      logTitle: "Permission denied",
      logBody: entry.reason
    });
  };

  try {
    const message = attachments?.length || agentMode ? { prompt, attachments, agentMode } : prompt;
    const response = await session.sendAndWait(message, timeout ?? DEFAULT_TURN_TIMEOUT_MS);
    const content = response?.data?.content ?? chunks.join("");

    return {
      content,
      reasoning: reasoning.join("") || (response?.data?.reasoningText ?? ""),
      sessionId: session.sessionId ?? null,
      model: response?.data?.model ?? null,
      outputTokens: response?.data?.outputTokens ?? null,
      toolCalls,
      denials,
      touchedFiles: [...touchedFiles],
      // Set when the policy paused a request for the owner. The caller writes an
      // awaiting-approval job instead of a completed one.
      escalated: Boolean(pendingApproval),
      pendingApproval
    };
  } finally {
    unsubscribe?.();
    sink.current = previousSink;
  }
}

export async function abortSession(session) {
  if (!session) return;
  try {
    await session.abort();
  } catch {
    // The turn may already be over; disconnecting is enough.
  }
  await session.disconnect?.().catch(() => {});
}

/**
 * Is a Copilot CLI available to run?
 *
 * The SDK depends on @github/copilot, so installing the SDK already brings a
 * CLI with it and no global install is needed. Checking only the PATH (what
 * upstream did) reported "not found" on a working setup and blocked every
 * command behind an install step the user did not need.
 */
export function getCopilotAvailability(cwd) {
  const override = sdkOverride();
  if (override) {
    return { available: true, detail: `fake runtime (${SDK_MODULE_ENV}=${override})`, source: "override" };
  }

  const onPath = binaryAvailable("copilot", ["--version"], { cwd });
  if (onPath.available) {
    return { ...onPath, source: "path" };
  }

  try {
    const require = createRequire(import.meta.url);
    const manifest = require("@github/copilot/package.json");
    return {
      available: true,
      detail: `GitHub Copilot CLI ${manifest.version} (bundled with @github/copilot-sdk)`,
      source: "bundled"
    };
  } catch {
    return { ...onPath, source: null };
  }
}

export function getSessionRuntimeStatus() {
  return {
    mode: "sdk",
    label: "SDK managed",
    detail: "Copilot CLI process managed by @github/copilot-sdk."
  };
}

/**
 * Real authentication status.
 *
 * Upstream returned a hardcoded `loggedIn: true` with the detail string
 * "assumed authenticated", so `/copilot:setup` reported success on a machine
 * that had never logged in. The SDK answers this properly.
 */
export async function getCopilotLoginStatus(cwd = process.cwd()) {
  let client;
  try {
    client = await ensureClient(cwd);
  } catch (error) {
    return {
      available: false,
      loggedIn: false,
      detail:
        error.code === "SDK_MISSING"
          ? `${SDK_PACKAGE} is not installed. ${SDK_INSTALL_HINT}`
          : `Could not start the Copilot runtime: ${error.message}`,
      authType: null,
      login: null,
      host: null
    };
  }

  try {
    const status = await client.getAuthStatus();
    return {
      available: true,
      loggedIn: Boolean(status?.isAuthenticated),
      detail:
        status?.statusMessage ?? (status?.isAuthenticated ? "authenticated" : "not authenticated"),
      authType: status?.authType ?? null,
      login: status?.login ?? null,
      host: status?.host ?? null
    };
  } catch (error) {
    return {
      available: true,
      loggedIn: false,
      detail: `Could not read authentication status: ${error.message}`,
      authType: null,
      login: null,
      host: null
    };
  }
}

/** Models this account can actually use. */
export async function listModels(cwd = process.cwd()) {
  try {
    const client = await ensureClient(cwd);
    const models = await client.listModels();
    return Array.isArray(models) ? models : [];
  } catch {
    return [];
  }
}

function* jsonCandidates(rawOutput) {
  const text = String(rawOutput).trim();
  yield text;

  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n?```/i);
  if (fenced) yield fenced[1].trim();

  // Last resort: the outermost brace pair, for prose wrapped around JSON.
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) yield text.slice(first, last + 1);
}

/**
 * Parse a JSON payload out of a model's final message.
 *
 * Models wrap JSON in fenced code blocks often enough that a bare JSON.parse
 * throws on output that is otherwise perfectly good, so unwrap before parsing.
 */
export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage || "Copilot did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  for (const candidate of jsonCandidates(rawOutput)) {
    try {
      return { parsed: JSON.parse(candidate), parseError: null, rawOutput, ...fallback };
    } catch {
      // Try the next candidate.
    }
  }

  return {
    parsed: null,
    parseError: "Copilot's final message was not valid JSON.",
    rawOutput,
    ...fallback
  };
}

export function buildPersistentTaskSessionId(prompt) {
  const excerpt = shorten(prompt, 56);
  const slug = excerpt
    ? excerpt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    : "";
  const prefix = TASK_SESSION_PREFIX.toLowerCase().replace(/\s+/g, "-");
  // The slug is for humans reading ~/.copilot/session-state; the suffix keeps
  // two runs of the same prompt (every stop-gate review, every "continue")
  // from asking the CLI to create a session whose id already exists.
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return slug ? `${prefix}-${slug}-${suffix}` : `${prefix}-${suffix}`;
}

export { DEFAULT_CONTINUE_PROMPT, TASK_SESSION_PREFIX, SESSION_ID_ENV, READ_ONLY, WORKSPACE_WRITE };

/**
 * The stored result of a task job. Carries what the permission handler saw
 * during the turn, so the report can say which files changed and what was
 * refused instead of pretending nothing was.
 *
 * @param {object} result  What runPrompt returned.
 * @param {{sessionId?: string|null, rawOutput?: string, unsafeShell?: boolean}} [meta]
 */
export function buildTaskPayload(result, { sessionId, rawOutput, unsafeShell } = {}) {
  const output = rawOutput ?? result?.content ?? "";
  return {
    status: output ? 0 : 1,
    sessionId: result?.sessionId ?? sessionId ?? null,
    rawOutput: output,
    touchedFiles: Array.isArray(result?.touchedFiles) ? result.touchedFiles : [],
    denials: Array.isArray(result?.denials) ? result.denials : [],
    unsafeShell: Boolean(unsafeShell),
    reasoningSummary: result?.reasoning ? [result.reasoning] : []
  };
}
