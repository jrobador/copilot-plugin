/**
 * run_command: the only way a delegated job runs a program.
 *
 * The runtime's own shell tools (`bash`, `powershell` and their helpers) hand
 * the model an interpreter. Fencing an interpreter by reading its input is a
 * losing game on any OS, and on Windows the runtime does not even try: its
 * path extractor returns nothing for PowerShell. So those tools are excluded
 * from every session and replaced with this one, which takes a program name
 * and an argument list and spawns exactly that. No shell means no pipes,
 * redirection, `&&`, `cd`, globbing or variable expansion, and the same rules
 * hold on Linux, macOS and Windows.
 *
 * What this fences: which program runs, with which arguments, in which
 * directory, with which environment. What it does not fence: what that
 * program then does. `npm test` runs the repository's scripts with the user's
 * privileges; only an OS sandbox closes that, and this module is not one.
 *
 * Pure with respect to the SDK: node built-ins and sibling modules only.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { createWorkspacePolicy, isInsideWorkspace } from "./paths.mjs";
import {
  isProtectedPath,
  normalizeMode,
  READ_ONLY,
  RUN_COMMAND_TOOL_NAME,
  WORKSPACE_WRITE
} from "./permissions.mjs";
import { resolveBinary, terminateProcessTree } from "./process.mjs";

export { RUN_COMMAND_TOOL_NAME };

/** Runtime tools that hand the model a shell. Excluded from every session. */
export const SHELL_TOOL_NAMES = Object.freeze([
  "bash",
  "read_bash",
  "write_bash",
  "stop_bash",
  "list_bash",
  "powershell",
  "read_powershell",
  "write_powershell",
  "stop_powershell",
  "list_powershell"
]);

export const MIN_TIMEOUT_MS = 1000;
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const MAX_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;
export const DEFAULT_MAX_OUTPUT_BYTES = 200 * 1024;

export const LIMITS = Object.freeze({
  maxArgs: 128,
  maxArgLength: 4096,
  maxTotalArgLength: 32 * 1024
});

const PROGRAM_NAME_PATTERN = /^[A-Za-z0-9._+-]+$/;

/** Read-only jobs may look at history and search. Nothing else. */
export const READ_ONLY_PROGRAMS = Object.freeze(["git", "rg"]);

/** Write-capable jobs get the common toolchains, plus whatever setup allowed. */
export const WRITE_PROGRAMS = Object.freeze([
  "git",
  "npm",
  "pnpm",
  "yarn",
  "npx",
  "node",
  "python",
  "python3",
  "pytest",
  "dotnet",
  "cargo",
  "go",
  "make",
  "rg",
  "ls"
]);

export const READ_ONLY_GIT_SUBCOMMANDS = Object.freeze([
  "log",
  "diff",
  "show",
  "status",
  "blame",
  "grep",
  "ls-files",
  "rev-parse",
  "branch",
  "describe",
  "shortlog",
  "cat-file",
  "remote"
]);

/** The only options accepted before the git subcommand, in either mode. */
export const GIT_LEADING_OPTIONS_ALLOWED = Object.freeze(["--no-pager", "--no-optional-locks"]);

const GIT_BRANCH_MUTATING_FLAGS = Object.freeze([
  "-d",
  "-D",
  "--delete",
  "-m",
  "-M",
  "--move",
  "-c",
  "-C",
  "--copy",
  "-u",
  "--set-upstream-to",
  "--unset-upstream",
  "--edit-description",
  "-f",
  "--force",
  "-t",
  "--track"
]);

const PACKAGE_MANAGER_FLAGS = Object.freeze(["--prefix", "--userconfig", "--globalconfig", "-g", "--global", "--cwd"]);

/**
 * Options that relocate a program outside the workspace or make it evaluate
 * code that is not a file we can fence. Matched as the whole argument, as a
 * `flag=value` prefix, and (for single-letter flags) glued: `make -C../x`.
 * Refused in both modes.
 */
export const DENIED_FLAGS = Object.freeze({
  // git rejects global options after the subcommand, and leading options are
  // gated separately below; listed anyway so the `=` forms are named clearly.
  git: ["--git-dir", "--work-tree", "--exec-path", "--namespace", "--config-env"],
  node: ["-e", "--eval", "-p", "--print", "-r", "--require", "--import", "--loader", "--experimental-loader", "-i", "--interactive"],
  python: ["-c"],
  python3: ["-c"],
  npm: PACKAGE_MANAGER_FLAGS,
  yarn: PACKAGE_MANAGER_FLAGS,
  npx: PACKAGE_MANAGER_FLAGS,
  pnpm: [...PACKAGE_MANAGER_FLAGS, "-C", "--dir"],
  cargo: ["--manifest-path", "--config"],
  go: ["-C", "-modfile"],
  make: ["-C", "-f", "--file", "--makefile", "--directory"],
  rg: ["--pre", "--pre-glob"]
});

/** Options that make an otherwise read-only program write or exec. */
export const READ_ONLY_DENIED_FLAGS = Object.freeze({
  git: ["--output", "-O", "--open-files-in-pager"]
});

export function allowedPrograms(mode, config = {}) {
  const effectiveMode = normalizeMode(mode);
  const base = effectiveMode === WORKSPACE_WRITE ? WRITE_PROGRAMS : READ_ONLY_PROGRAMS;
  const extra =
    effectiveMode === WORKSPACE_WRITE && Array.isArray(config.extraPrograms)
      ? config.extraPrograms
          .filter((program) => typeof program === "string" && PROGRAM_NAME_PATTERN.test(program))
          .map((program) => program.toLowerCase())
      : [];
  return [...new Set([...base, ...extra])];
}

/** Does this argument name a filesystem location worth checking? */
export function looksLikePath(arg) {
  if (typeof arg !== "string" || arg === "") return false;
  return /[\\/]/.test(arg) || arg.startsWith(".") || arg.startsWith("~") || /^[A-Za-z]:/.test(arg);
}

function quoteForDisplay(arg) {
  return /[\s"']/.test(arg) || arg === "" ? JSON.stringify(arg) : arg;
}

/** Display form used in logs and denial reports, never re-parsed. */
export function describeCommand(program, args) {
  const name = typeof program === "string" ? program : String(program);
  const list = Array.isArray(args) ? args.map((arg) => quoteForDisplay(String(arg))) : [];
  return `command: ${[name, ...list].join(" ")}`;
}

function matchesFlag(arg, flag) {
  if (arg === flag || arg.startsWith(`${flag}=`)) return true;
  // Glued short form: `-C../x`, `-cprint(1)`.
  return /^-[A-Za-z]$/.test(flag) && arg.length > 2 && arg.startsWith(flag);
}

function findDeniedFlag(args, flags) {
  for (const arg of args) {
    for (const flag of flags) {
      if (matchesFlag(arg, flag)) return { arg, flag };
    }
  }
  return null;
}

function planGit(args, effectiveMode) {
  // `git --version` / `git --help` take no subcommand and touch nothing.
  if (args.length === 1 && (args[0] === "--version" || args[0] === "--help")) {
    return { argv: ["--no-pager", ...args] };
  }
  let index = 0;
  while (index < args.length && args[index].startsWith("-")) {
    if (!GIT_LEADING_OPTIONS_ALLOWED.includes(args[index])) {
      return { error: `git global option \`${args[index]}\` is not allowed; only ${GIT_LEADING_OPTIONS_ALLOWED.join(" and ")} may precede the subcommand.` };
    }
    index += 1;
  }
  const subcommand = args[index];
  const rest = args.slice(index + 1);

  if (effectiveMode !== WORKSPACE_WRITE) {
    if (!subcommand) {
      return { error: "git needs a subcommand; read-only jobs may use: " + READ_ONLY_GIT_SUBCOMMANDS.join(", ") + "." };
    }
    if (!READ_ONLY_GIT_SUBCOMMANDS.includes(subcommand)) {
      return { error: `git ${subcommand} is not available to a read-only job; allowed subcommands: ${READ_ONLY_GIT_SUBCOMMANDS.join(", ")}.` };
    }
    if (subcommand === "branch") {
      const positional = rest.find((arg) => !arg.startsWith("-"));
      if (positional !== undefined) {
        return { error: `git branch with a positional argument (\`${positional}\`) creates or targets a branch; read-only jobs may only list (use --list, -a, -r, --contains=<ref>).` };
      }
      const mutating = findDeniedFlag(rest, GIT_BRANCH_MUTATING_FLAGS);
      if (mutating) {
        return { error: `git branch ${mutating.arg} modifies branches; read-only jobs may only list.` };
      }
    }
    if (subcommand === "remote") {
      const listing =
        rest.length === 0 ||
        (rest.length === 1 && (rest[0] === "-v" || rest[0] === "--verbose")) ||
        (rest[0] === "show" && rest.length === 2 && !rest[1].startsWith("-")) ||
        (rest[0] === "get-url" && rest.length >= 2 && !rest[rest.length - 1].startsWith("-"));
      if (!listing) {
        return { error: "git remote in a read-only job may only list: `remote`, `remote -v`, `remote show <name>`, `remote get-url <name>`." };
      }
    }
  }

  const argv = args[0] === "--no-pager" ? [...args] : ["--no-pager", ...args];
  return { argv };
}

/**
 * Decide whether a command may run, and with which argv. Pure.
 *
 * @param {{program?: unknown, args?: unknown}} request  What the model asked for.
 * @param {string} mode        READ_ONLY or WORKSPACE_WRITE.
 * @param {object|string} policy  createWorkspacePolicy result or a root path.
 * @param {{extraPrograms?: string[]}} [config]
 * @returns {{ok: boolean, program: string|null, argv: string[], reason: string, kind: "command", request: string}}
 */
export function planCommand(request, mode, policy, config = {}) {
  const effectiveMode = normalizeMode(mode);
  const program = request?.program;
  const rawArgs = request?.args;
  const display = describeCommand(program ?? "(no program)", Array.isArray(rawArgs) ? rawArgs : []);
  /** @returns {{ok: boolean, program: string|null, argv: string[], reason: string, kind: "command", request: string}} */
  const refuse = (reason) => ({ ok: false, program: null, argv: [], reason, kind: "command", request: display });

  if (typeof program !== "string" || program.trim() === "") {
    return refuse("program must be a non-empty string.");
  }
  if (/[\\/\0]/.test(program) || !PROGRAM_NAME_PATTERN.test(program)) {
    return refuse(`program must be a bare name found on PATH, not \`${program}\`.`);
  }
  const name = program.toLowerCase();

  if (rawArgs !== undefined && !Array.isArray(rawArgs)) {
    return refuse("args must be an array of strings.");
  }
  // Validated element by element just below; the annotation states the
  // post-validation shape so the rest of the function reads as strings.
  const args = /** @type {string[]} */ (rawArgs ?? []);
  if (args.length > LIMITS.maxArgs) {
    return refuse(`too many arguments (${args.length} > ${LIMITS.maxArgs}).`);
  }
  let total = 0;
  for (const arg of args) {
    if (typeof arg !== "string") {
      return refuse("args must be an array of strings.");
    }
    if (arg.length > LIMITS.maxArgLength) {
      return refuse(`argument too long (${arg.length} > ${LIMITS.maxArgLength} characters).`);
    }
    if (/[\0\r\n]/.test(arg)) {
      return refuse(`argument ${quoteForDisplay(arg)} contains a control character.`);
    }
    total += arg.length;
  }
  if (total > LIMITS.maxTotalArgLength) {
    return refuse(`arguments too long in total (${total} > ${LIMITS.maxTotalArgLength} characters).`);
  }

  const allowed = allowedPrograms(effectiveMode, config);
  if (!allowed.includes(name)) {
    const hint =
      effectiveMode === WORKSPACE_WRITE
        ? `allowed: ${allowed.join(", ")}`
        : "read-only jobs may run: git (read subcommands), rg";
    return refuse(`\`${program}\` is not on the ${effectiveMode} allowlist (${hint}).`);
  }

  let argv = [...args];
  if (name === "git") {
    const git = planGit(args, effectiveMode);
    if (git.error) return refuse(git.error);
    argv = git.argv;
  }

  const denied = findDeniedFlag(args, DENIED_FLAGS[name] ?? []);
  if (denied) {
    return refuse(`\`${denied.arg}\` is not allowed for ${name}: it relocates the program or evaluates code outside the workspace.`);
  }
  if (effectiveMode !== WORKSPACE_WRITE) {
    const readOnlyDenied = findDeniedFlag(args, READ_ONLY_DENIED_FLAGS[name] ?? []);
    if (readOnlyDenied) {
      return refuse(`\`${readOnlyDenied.arg}\` is not allowed for ${name} in a read-only job: it writes or executes.`);
    }
  }

  const workspace =
    policy && typeof policy === "object" && policy.rootCanonical ? policy : createWorkspacePolicy(policy);
  for (const arg of args) {
    const equals = arg.startsWith("-") ? arg.indexOf("=") : -1;
    const candidate = equals > 0 ? arg.slice(equals + 1) : arg;
    if (!looksLikePath(candidate)) continue;
    const check = isInsideWorkspace(workspace, candidate, { cwd: workspace.cwd });
    if (!check.inside) {
      const why = check.error
        ? `is not a valid path (${check.error})`
        : `resolves to ${check.resolved}, outside the workspace ${workspace.root}`;
      return refuse(`argument ${quoteForDisplay(arg)} ${why}.`);
    }
    if (effectiveMode === WORKSPACE_WRITE) {
      const protection = isProtectedPath(check.relative);
      if (protection.protected) {
        return refuse(`argument ${quoteForDisplay(arg)} is a protected path (${protection.pattern}).`);
      }
    }
  }

  return {
    ok: true,
    program: name,
    argv,
    reason: `Allowed: ${name} is on the ${effectiveMode} allowlist.`,
    kind: "command",
    request: display
  };
}

const SCRUB_PATTERN =
  /^(GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|EXEC_PATH|CEILING_DIRECTORIES|EXTERNAL_DIFF|PAGER|EDITOR|SSH_COMMAND|CONFIG.*)|NODE_OPTIONS|NODE_REPL_EXTERNAL_MODULE|PYTHONSTARTUP|PYTHONPATH|npm_config_.*)$/i;

/**
 * The child's environment: the caller's, minus variables that relocate git,
 * inject code into node/python, or reconfigure npm; plus git set to never
 * page or prompt. PATH and the OS essentials are never touched.
 */
export function scrubEnvironment(env = process.env) {
  /** @type {NodeJS.ProcessEnv} */
  const scrubbed = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || SCRUB_PATTERN.test(key)) continue;
    scrubbed[key] = value;
  }
  scrubbed.GIT_TERMINAL_PROMPT = "0";
  scrubbed.GIT_PAGER = "cat";
  return scrubbed;
}

const CMD_METACHARACTERS = /[&|<>^%!"\r\n]/;

/**
 * Turn a plan into something spawn() can run without a shell.
 *
 * Windows is the wrinkle: npm and friends install `.cmd` shims, which Node
 * refuses to spawn directly. npm and npx have a JS entry point next to node
 * that we can run with node itself. Any other shim goes through cmd.exe, and
 * since cmd.exe *is* an interpreter, that path is only taken when no argument
 * contains a character cmd.exe would interpret.
 */
export function resolveLaunch(plan, options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const execPath = options.execPath ?? process.execPath;
  const resolved = resolveBinary(plan.program, env);
  if (!resolved) {
    return { ok: false, denial: false, reason: `${plan.program} was not found on PATH.` };
  }
  const isWindows = platform === "win32";

  if (isWindows && (plan.program === "npm" || plan.program === "npx")) {
    const cli = path.join(path.dirname(execPath), "node_modules", "npm", "bin", `${plan.program}-cli.js`);
    if (fs.existsSync(cli)) {
      return { ok: true, file: execPath, args: [cli, ...plan.argv], options: {}, via: "node" };
    }
  }

  if (isWindows && /\.(cmd|bat)$/i.test(resolved)) {
    const offending = plan.argv.find((arg) => CMD_METACHARACTERS.test(arg));
    if (offending !== undefined) {
      return {
        ok: false,
        denial: true,
        reason: `${plan.program} resolves to a .cmd shim (${resolved}) that must run through cmd.exe, and argument ${quoteForDisplay(offending)} contains a cmd metacharacter; use a plain argument or run the underlying program directly.`
      };
    }
    const quote = (text) => `"${text}"`;
    const line = [resolved, ...plan.argv].map(quote).join(" ");
    return {
      ok: true,
      file: options.comspec ?? env.ComSpec ?? env.COMSPEC ?? "cmd.exe",
      args: ["/d", "/s", "/c", `"${line}"`],
      options: { windowsVerbatimArguments: true },
      via: "cmd"
    };
  }

  return { ok: true, file: resolved, args: plan.argv, options: {}, via: "direct" };
}

function clampTimeout(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(number)));
}

/**
 * Keep the first ~60% and the last ~40% of a stream, dropping the middle
 * once the cap is reached. Long test runs put the summary at the end and the
 * failing case near where it broke; both survive.
 */
function createOutputCollector(maxBytes) {
  const headLimit = Math.max(1, Math.floor(maxBytes * 0.6));
  const tailLimit = Math.max(1, maxBytes - headLimit);
  const head = [];
  const tail = [];
  let headBytes = 0;
  let tailBytes = 0;
  let dropped = 0;

  return {
    push(chunk) {
      let remaining = chunk;
      if (headBytes < headLimit) {
        const take = Math.min(remaining.length, headLimit - headBytes);
        head.push(remaining.subarray(0, take));
        headBytes += take;
        remaining = remaining.subarray(take);
      }
      if (remaining.length === 0) return;
      tail.push(remaining);
      tailBytes += remaining.length;
      while (tailBytes > tailLimit && tail.length > 0) {
        const excess = tailBytes - tailLimit;
        const first = tail[0];
        if (first.length <= excess) {
          tail.shift();
          tailBytes -= first.length;
          dropped += first.length;
        } else {
          tail[0] = first.subarray(excess);
          tailBytes -= excess;
          dropped += excess;
        }
      }
    },
    finish() {
      const headText = Buffer.concat(head).toString("utf8");
      const tailText = Buffer.concat(tail).toString("utf8");
      const marker = dropped > 0 ? `\n[... ${dropped} bytes truncated ...]\n` : "";
      return { output: `${headText}${marker}${tailText}`, truncatedBytes: dropped };
    }
  };
}

/**
 * Run a planned command to completion.
 *
 * @returns {Promise<{ok: boolean, resultType: "success"|"failure"|"denied"|"timeout", exitCode: number|null, signal: string|null, timedOut: boolean, output: string, truncatedBytes: number, durationMs: number, file: string|null, error: string|null, denial: boolean}>}
 */
export function executeCommand(plan, options = {}) {
  const cwd = options.cwd;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const timeoutMs = clampTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maxOutputBytes = Math.max(1024, Number(options.maxOutputBytes) || DEFAULT_MAX_OUTPUT_BYTES);

  const launch = resolveLaunch(plan, { env, platform, execPath: options.execPath, comspec: options.comspec });
  const base = {
    ok: false,
    exitCode: null,
    signal: null,
    timedOut: false,
    output: "",
    truncatedBytes: 0,
    durationMs: 0,
    file: null,
    error: null,
    denial: false
  };
  if (!launch.ok) {
    return Promise.resolve({
      ...base,
      resultType: launch.denial ? "denied" : "failure",
      error: launch.reason,
      denial: launch.denial
    });
  }

  return new Promise((resolve) => {
    const started = Date.now();
    const collector = createOutputCollector(maxOutputBytes);
    let settled = false;
    let timedOut = false;
    /** @type {import("node:child_process").ChildProcess|undefined} */
    let child;
    let hardKill = null;

    const finish = (partial) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hardKill) clearTimeout(hardKill);
      const { output, truncatedBytes } = collector.finish();
      resolve({
        ...base,
        file: launch.file,
        output,
        truncatedBytes,
        timedOut,
        durationMs: Date.now() - started,
        ...partial
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        terminateProcessTree(child?.pid, { env });
      } catch {
        // Best effort; the hard kill below is the backstop.
      }
      hardKill = setTimeout(() => {
        try {
          child?.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }, 5000);
    }, timeoutMs);

    try {
      child = spawn(launch.file, launch.args, {
        cwd,
        env: scrubEnvironment(env),
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: launch.options.windowsVerbatimArguments === true,
        stdio: ["ignore", "pipe", "pipe"],
        // A process group of its own, so a timeout can take the whole tree
        // (npm test spawns grandchildren). Windows uses taskkill /T instead.
        detached: platform !== "win32"
      });
    } catch (error) {
      finish({ resultType: "failure", error: error.message });
      return;
    }

    child.stdout?.on("data", (chunk) => collector.push(chunk));
    child.stderr?.on("data", (chunk) => collector.push(chunk));
    child.on("error", (error) => finish({ resultType: "failure", error: error.message }));
    child.on("close", (code, signal) => {
      if (timedOut) {
        finish({ resultType: "timeout", exitCode: code, signal, error: `timed out after ${timeoutMs} ms` });
      } else if (code === 0) {
        finish({ ok: true, resultType: "success", exitCode: 0, signal });
      } else {
        finish({
          resultType: "failure",
          exitCode: code,
          signal,
          error: code === null ? `terminated by signal ${signal}` : `exit code ${code}`
        });
      }
    });
  });
}

/** The text the model sees. */
export function formatCommandResult(exec) {
  if (exec.exitCode === null && !exec.timedOut && exec.error) {
    return `[failed to start: ${exec.error}]`;
  }
  const output = exec.output ?? "";
  const separator = output === "" || output.endsWith("\n") ? "" : "\n";
  if (exec.timedOut) {
    return `${output}${separator}[timed out after ${Math.round(exec.durationMs / 1000)}s; process tree terminated]`;
  }
  const status = exec.exitCode === null ? `terminated by signal ${exec.signal}` : `exit code ${exec.exitCode}`;
  return `${output}${separator}[${status}]`;
}

export const RUN_COMMAND_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    program: {
      type: "string",
      description: "Bare program name found on PATH, e.g. git, npm, node. Never a path."
    },
    args: {
      type: "array",
      items: { type: "string" },
      description: "Arguments, one per element, unquoted. No shell syntax."
    },
    description: {
      type: "string",
      description: "One line on why this command is needed."
    },
    timeoutMs: {
      type: "integer",
      minimum: MIN_TIMEOUT_MS,
      maximum: MAX_TIMEOUT_MS,
      description: "Kill the process tree after this long. Default 10 minutes."
    }
  },
  required: ["program"],
  additionalProperties: false
});

export function buildRunCommandDescription(mode, policy, config = {}) {
  const effectiveMode = normalizeMode(mode);
  const programs = allowedPrograms(effectiveMode, config);
  const readOnlyNote =
    effectiveMode === WORKSPACE_WRITE
      ? ""
      : ` This is a read-only job: only rg and these git subcommands: ${READ_ONLY_GIT_SUBCOMMANDS.join(", ")} (branch and remote in listing form only; use --flag=value forms).`;
  return (
    "Run one program directly with an argument list. There is no shell: no pipes, redirection, globbing, &&, cd, or VAR=x prefixes; one program per call. " +
    `The working directory is ${policy.cwd} and every path argument must stay inside ${policy.root}; .git/, .github/workflows/, .husky/ and .vscode/tasks.json are off limits. ` +
    `Allowed programs: ${programs.join(", ")}.${readOnlyNote} ` +
    "Options that relocate a program or evaluate inline code (git -C, --git-dir, npm --prefix, node -e/-r, make -C, rg --pre, ...) are refused. " +
    "Output is capped at 200 KB (middle truncated) and the process tree is killed after timeoutMs (default 10 minutes)."
  );
}

function previewOf(output, lines = 20, maxChars = 2000) {
  const text = String(output ?? "");
  const head = text.split("\n").slice(0, lines).join("\n");
  return head.length > maxChars ? `${head.slice(0, maxChars)}…` : head;
}

/**
 * The Tool object for SessionConfig.tools. The handler never throws: every
 * outcome, including our own refusals, is reported to the model as a result
 * and to the job through onDecision.
 *
 * @param {object} options
 * @param {string} options.mode
 * @param {object|string} options.policy   createWorkspacePolicy result or a root path.
 * @param {{extraPrograms?: string[]}} [options.config]
 * @param {(entry: object) => void} [options.onDecision]  Same observer the permission handler uses.
 * @param {NodeJS.ProcessEnv} [options.env]      Test seam; defaults to process.env.
 * @param {number} [options.timeoutMs]           Test seam; see LIMITS.
 * @param {number} [options.maxOutputBytes]      Test seam; see LIMITS.
 * @param {string} [options.platform]            Test seam; defaults to process.platform.
 * @param {string} [options.execPath]            Test seam; defaults to process.execPath.
 * @param {string} [options.comspec]             Test seam; defaults to env.ComSpec.
 */
export function createRunCommandTool(options) {
  const mode = normalizeMode(options.mode);
  const policy =
    options.policy && typeof options.policy === "object" && options.policy.rootCanonical
      ? options.policy
      : createWorkspacePolicy(options.policy ?? process.cwd());
  const config = options.config ?? {};
  const onDecision = options.onDecision;

  const report = (allowed, reason, request, detail) => {
    try {
      onDecision?.({ allowed, reason, mode, request, kind: "command", file: null, ...(detail ? { detail } : {}) });
    } catch {
      // An observer failure must never break the tool.
    }
  };
  const denied = (reason) => ({ textResultForLlm: `Refused: ${reason}`, resultType: "denied", error: reason });

  return {
    name: RUN_COMMAND_TOOL_NAME,
    description: buildRunCommandDescription(mode, policy, config),
    parameters: RUN_COMMAND_SCHEMA,
    skipPermission: true,
    defer: "never",
    handler: async (rawArgs) => {
      try {
        const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {};
        const plan = planCommand(args, mode, policy, config);
        if (!plan.ok) {
          report(false, plan.reason, plan.request);
          return denied(plan.reason);
        }
        const exec = await executeCommand(plan, {
          cwd: policy.cwd,
          env: options.env,
          timeoutMs: args.timeoutMs ?? options.timeoutMs,
          maxOutputBytes: options.maxOutputBytes,
          platform: options.platform,
          execPath: options.execPath,
          comspec: options.comspec
        });
        if (exec.denial) {
          report(false, exec.error, plan.request);
          return denied(exec.error);
        }
        report(true, plan.reason, plan.request, {
          exitCode: exec.exitCode,
          timedOut: exec.timedOut,
          durationMs: exec.durationMs,
          file: exec.file,
          preview: previewOf(exec.output)
        });
        const result = { textResultForLlm: formatCommandResult(exec), resultType: exec.resultType };
        if (exec.resultType !== "success") result.error = exec.error ?? `exit code ${exec.exitCode}`;
        return result;
      } catch (error) {
        const reason = `run_command failed unexpectedly: ${error?.message ?? error}`;
        report(false, reason, describeCommand(rawArgs?.program ?? "(no program)", rawArgs?.args));
        return { textResultForLlm: `[${reason}]`, resultType: "failure", error: reason };
      }
    }
  };
}
