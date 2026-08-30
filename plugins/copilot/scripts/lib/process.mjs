import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

/** cmd.exe's exit code for a command it could not find. */
const WINDOWS_COMMAND_NOT_FOUND = 9009;
/** POSIX shells use 127 for the same condition. */
const POSIX_COMMAND_NOT_FOUND = 127;

/**
 * On Windows the command runs through cmd.exe, which reports a missing binary
 * as a normal non-zero exit rather than surfacing spawn's ENOENT. Detect that
 * and synthesize the error so callers get one answer on every platform.
 *
 * Only the exit code is inspected, never the message: cmd.exe localizes
 * "is not recognized as an internal or external command" to the system
 * language, so matching on that text fails on any non-English machine.
 */
function missingBinaryError(command, result) {
  if (result.error) return null;
  if (result.status !== WINDOWS_COMMAND_NOT_FOUND && result.status !== POSIX_COMMAND_NOT_FOUND) {
    return null;
  }

  return Object.assign(new Error(`spawnSync ${command} ENOENT`), {
    code: "ENOENT",
    syscall: "spawnSync",
    path: command
  });
}

/**
 * Locate an executable the way the OS would, without running anything.
 *
 * Used instead of trusting exit codes, which cannot distinguish "no such
 * binary" from "the binary ran and failed" once a shell is in the way.
 * Returns the resolved path, or null when the command is not on PATH.
 */
export function resolveBinary(command, env = process.env) {
  if (!command) return null;

  const isWindows = process.platform === "win32";
  const extensions = isWindows
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];

  // On Windows the bare name often exists too: npm ships `npm` (a POSIX sh
  // shim for Git Bash) next to `npm.cmd`. cmd.exe would never pick the shim,
  // and spawning it directly fails with ENOENT, so try PATHEXT first and only
  // accept the bare name when it already carries an executable extension.
  const lower = (text) => text.toLowerCase();
  const candidates = (base) =>
    isWindows
      ? [
          ...extensions.map((extension) => `${base}${extension}`),
          ...(extensions.some((extension) => lower(base).endsWith(lower(extension))) ? [base] : [])
        ]
      : [base];

  const isExecutableFile = (candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  };

  if (command.includes("/") || command.includes("\\")) {
    return candidates(path.resolve(command)).find(isExecutableFile) ?? null;
  }

  const searchPath = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  for (const directory of searchPath) {
    const found = candidates(path.join(directory, command)).find(isExecutableFile);
    if (found) return found;
  }
  return null;
}

/** Windows launchers that only cmd.exe can run. */
const SHELL_SHIM = /\.(cmd|bat)$/i;

/**
 * Run one program with an argument list.
 *
 * No shell, on any platform, unless the program is a `.cmd`/`.bat` shim that
 * Node cannot spawn directly (npm, copilot). Everything else -- git.exe,
 * node.exe, taskkill.exe -- is spawned as-is, so an argument is never
 * re-parsed by cmd.exe: a git ref carrying `&&` stays a ref. The shim path is
 * only ever used with constant arguments (`--version`).
 */
export function runCommand(command, args = [], options = {}) {
  const resolved = resolveBinary(command, options.env ?? process.env);
  const useShell = process.platform === "win32" && SHELL_SHIM.test(resolved ?? command);
  const result = spawnSync(resolved ?? command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    stdio: options.stdio ?? "pipe",
    shell: useShell,
    windowsHide: true,
    // Node's default is 1 MB, which a real diff exceeds; the caller caps what
    // it keeps (truncateDiff), so the buffer only has to hold what git emits.
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024
  });

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? missingBinaryError(command, result)
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  // Resolve on PATH first. Running the command and reading its exit code
  // cannot tell "not installed" apart from "installed but exited non-zero"
  // once cmd.exe is in the path, and this avoids spawning a process at all.
  if (!resolveBinary(command, options.env ?? process.env)) {
    return { available: false, detail: "not found" };
  }

  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

/** Is a process with this pid alive? Signal 0 probes without sending anything. */
export function isProcessAlive(pid, killImpl = process.kill.bind(process)) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    killImpl(Math.floor(pid), 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else. Alive, and not ours.
    return /** @type {NodeJS.ErrnoException} */ (error)?.code === "EPERM";
  }
}

/**
 * The command line of a process, or null when it cannot be read. A stored pid
 * outlives the worker it belonged to and can be reused by anything; this is
 * how a kill checks it is still aiming at one of our workers.
 */
export function processCommandLine(pid, options = {}) {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const id = Math.floor(pid);
  const platform = options.platform ?? process.platform;
  const run = options.runCommandImpl ?? runCommand;

  if (platform === "win32") {
    // PowerShell without a shell in between; the only interpolated value is a
    // number.
    const result = run("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter "ProcessId = ${id}").CommandLine`
    ]);
    const text = result.error || result.status !== 0 ? "" : result.stdout.trim();
    return text || null;
  }

  if (platform === "linux") {
    try {
      const raw = fs.readFileSync(`/proc/${id}/cmdline`, "utf8");
      return raw.split("\0").filter(Boolean).join(" ") || null;
    } catch {
      return null;
    }
  }

  const result = run("ps", ["-o", "args=", "-p", String(id)]);
  const text = result.error || result.status !== 0 ? "" : result.stdout.trim();
  return text || null;
}

/** taskkill's exit code when the target pid does not exist. */
const TASKKILL_PROCESS_NOT_FOUND = 128;

/**
 * Fallback heuristic only. taskkill localizes its error text, so on a Spanish
 * or German Windows this never matches; the exit code above is the signal that
 * actually works. Kept for shells that report a different code.
 */
function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

/**
 * Kill a process and its children.
 *
 * With `options.identity`, the target's command line is read first and the
 * kill only proceeds when the predicate accepts it; a pid whose command line
 * cannot be read or does not match is left alone and reported as such. Pids
 * come from job records that may be hours old, and Windows reuses them.
 *
 * @param {number} pid
 * @param {{
 *   identity?: (commandLine: string) => boolean,
 *   commandLineImpl?: (pid: number) => string|null,
 *   platform?: string,
 *   runCommandImpl?: typeof runCommand,
 *   killImpl?: typeof process.kill,
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv
 * }} [options]
 */
export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null, reason: "no pid" };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (typeof options.identity === "function") {
    const commandLineImpl = options.commandLineImpl ?? ((target) => processCommandLine(target, { platform, runCommandImpl }));
    const commandLine = commandLineImpl(pid);
    if (commandLine == null) {
      return { attempted: false, delivered: false, method: null, reason: "process not found or its command line is unreadable" };
    }
    if (!options.identity(commandLine)) {
      return { attempted: false, delivered: false, method: null, reason: `pid ${pid} now belongs to another process` };
    }
  }

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (
      !result.error &&
      (result.status === TASKKILL_PROCESS_NOT_FOUND ||
        looksLikeMissingProcessMessage(combinedOutput))
    ) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (/** @type {NodeJS.ErrnoException|undefined} */ (result.error)?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error)?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  try {
    killImpl(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try {
        killImpl(pid, "SIGTERM");
        return { attempted: true, delivered: true, method: "process" };
      } catch (innerError) {
        if (innerError?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "process" };
        }
        throw innerError;
      }
    }

    return { attempted: true, delivered: false, method: "process-group" };
  }
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
