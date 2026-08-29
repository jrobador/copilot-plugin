/**
 * Workspace containment for permission decisions.
 *
 * The SDK reports the path a tool wants to touch, but says nothing about
 * whether that path is inside the workspace the job was scoped to; its
 * `requestSandboxBypass` flag only exists when a host configures a sandbox,
 * which this plugin does not. So the policy has to answer the question
 * itself, and it has to answer it the way the filesystem would: after `..`,
 * after symlinks and junctions, after Windows 8.3 short names and drive-letter
 * case. Anything less is a fence with a gap in it.
 *
 * Pure with respect to the SDK: only node:path, node:fs and node:os.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const IS_WINDOWS = process.platform === "win32";

function compareKey(text) {
  // NTFS is case-insensitive by default. Comparing lowercased strings is not
  // strictly correct for every locale, but realpath has already normalized
  // both sides to on-disk casing, so this only matters for the not-yet-
  // existing tail of a path.
  return IS_WINDOWS ? text.toLowerCase() : text;
}

function isUncPath(text) {
  return IS_WINDOWS && /^[\\/]{2}[^\\/?.]/.test(text);
}

/**
 * Validate and pre-normalize raw input from the SDK before resolving it.
 * Throws on anything that cannot be a real file path; callers fail closed.
 */
function normalizeInput(candidate) {
  if (typeof candidate !== "string") {
    throw new Error("path is not a string");
  }
  if (candidate.trim() === "") {
    throw new Error("path is empty");
  }
  if (candidate.includes("\0")) {
    throw new Error("path contains a NUL byte");
  }

  let text = candidate;

  if (IS_WINDOWS) {
    const slashed = text.replace(/\//g, "\\");
    if (slashed.startsWith("\\\\.\\")) {
      // Device namespace (\\.\PhysicalDrive0, \\.\pipe\x): never a file we
      // should be writing on a job's behalf.
      throw new Error("device namespace paths are not allowed");
    }
    if (slashed.startsWith("\\\\?\\")) {
      // Extended-length prefix. Strip it so the rest of the pipeline sees a
      // normal path: \\?\C:\x -> C:\x, \\?\UNC\srv\share -> \\srv\share.
      const rest = slashed.slice(4);
      text = /^UNC\\/i.test(rest) ? `\\\\${rest.slice(4)}` : rest;
    }
  }

  // Shell-derived paths arrive unexpanded. Resolve `~` the way a shell would so
  // `~/.ssh/id_rsa` is judged as the home directory, not as a file named `~`.
  if (text === "~") {
    return os.homedir();
  }
  if (text.startsWith("~/") || (IS_WINDOWS && text.startsWith("~\\"))) {
    return path.join(os.homedir(), text.slice(2));
  }

  return text;
}

/**
 * Canonical form of an absolute path: the realpath of its nearest existing
 * ancestor joined with the not-yet-existing tail. This resolves symlinks,
 * junctions, 8.3 short names and drive-letter case for files that do not
 * exist yet, which is exactly the case a write request is about.
 *
 * @param {string} absolutePath  Already resolved with path.resolve.
 */
export function canonicalizePath(absolutePath) {
  const tail = [];
  let current = absolutePath;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...tail);
    } catch {
      // Not there (or not readable): step up one level and remember the name.
    }
    const parent = path.dirname(current);
    if (parent === current) {
      // Reached a drive or share root that itself could not be resolved.
      return path.join(current, ...tail);
    }
    tail.unshift(path.basename(current));
    current = parent;
  }
}

function isContained(rootCanonical, resolved) {
  const rel = path.relative(compareKey(rootCanonical), compareKey(resolved));
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false; // other drive or share on Windows
  // `..` alone, or `..` followed by a separator. Not a bare startsWith("..")
  // check, which would reject a file legitimately named `..foo`.
  return rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

function toPosixRelative(rootCanonical, resolved) {
  return path.relative(rootCanonical, resolved).split(path.sep).join("/");
}

/**
 * Pre-compute the canonical workspace root once so a long-lived permission
 * handler does not realpath it on every request.
 *
 * @param {string} root  Workspace root in any spelling: git's forward-slash
 *                       form, an 8.3 short name, a path through a junction.
 * @param {string} [cwd] Directory relative paths resolve against; defaults to root.
 */
export function createWorkspacePolicy(root, cwd = root) {
  const rootResolved = path.resolve(String(root));
  const cwdResolved = path.resolve(String(cwd ?? root));
  return {
    root: rootResolved,
    rootCanonical: canonicalizePath(rootResolved),
    cwd: cwdResolved,
    cwdCanonical: canonicalizePath(cwdResolved)
  };
}

function toPolicy(rootOrPolicy, cwd) {
  if (rootOrPolicy && typeof rootOrPolicy === "object" && rootOrPolicy.rootCanonical) {
    return cwd ? { ...rootOrPolicy, cwdCanonical: canonicalizePath(path.resolve(cwd)) } : rootOrPolicy;
  }
  return createWorkspacePolicy(rootOrPolicy, cwd);
}

/**
 * Decide whether `candidate` lies inside the workspace.
 *
 * @param {string|object} root   Workspace root, or an object from createWorkspacePolicy.
 * @param {unknown} candidate    fileName/path as the SDK gave it. Relative paths
 *                               resolve against opts.cwd, then the root.
 * @param {{cwd?: string}} [opts]
 * @returns {{inside: boolean, resolved: string|null, relative: string|null, error: string|null}}
 *   `relative` is posix-separated and "" for the root itself. `inside` is
 *   always false when `error` is set: malformed input fails closed.
 */
export function isInsideWorkspace(root, candidate, opts = {}) {
  let policy;
  try {
    policy = toPolicy(root, opts.cwd);
  } catch (error) {
    return { inside: false, resolved: null, relative: null, error: `invalid workspace root: ${error.message}` };
  }

  let input;
  try {
    input = normalizeInput(candidate);
  } catch (error) {
    return { inside: false, resolved: null, relative: null, error: error.message };
  }

  const resolvedRaw = path.resolve(policy.cwdCanonical, input);

  // A UNC candidate on a different share cannot be inside a workspace on this
  // one, and realpath on an unreachable share stalls on a network lookup.
  // Decide it without touching the network.
  if (isUncPath(resolvedRaw)) {
    const candidateRoot = compareKey(path.parse(resolvedRaw).root);
    const workspaceRoot = compareKey(path.parse(policy.rootCanonical).root);
    if (candidateRoot !== workspaceRoot) {
      return { inside: false, resolved: resolvedRaw, relative: null, error: null };
    }
  }

  const resolved = canonicalizePath(resolvedRaw);
  const inside = isContained(policy.rootCanonical, resolved);
  return {
    inside,
    resolved,
    relative: inside ? toPosixRelative(policy.rootCanonical, resolved) : null,
    error: null
  };
}
