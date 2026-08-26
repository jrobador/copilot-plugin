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

  const candidates = (base) =>
    [base, ...extensions.map((extension) => `${base}${extension}`)].filter(Boolean);

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

export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    stdio: options.stdio ?? "pipe",
    shell: process.platform === "win32",
    windowsHide: true
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

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

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

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
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
