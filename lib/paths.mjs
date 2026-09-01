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
 * @param {string[]} [additionalDirectories]  Extra roots from `--add-dir`. A path
 *                       inside any of them counts as inside the workspace.
 */
export function createWorkspacePolicy(root, cwd = root, additionalDirectories = []) {
  const rootResolved = path.resolve(String(root));
  const cwdResolved = path.resolve(String(cwd ?? root));
  const roots = [];
  const seen = new Set();
  for (const entry of [rootResolved, ...(Array.isArray(additionalDirectories) ? additionalDirectories : [])]) {
    const resolved = path.resolve(String(entry));
    const canonical = canonicalizePath(resolved);
    const key = compareKey(canonical);
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push({ resolved, canonical });
  }
  return {
    // The primary root: what a denial names, and what the run_command
    // description points the model at. `roots` is the whole fence.
    root: rootResolved,
    rootCanonical: roots[0].canonical,
    roots,
    cwd: cwdResolved,
    cwdCanonical: canonicalizePath(cwdResolved)
  };
}

/**
 * Resolve `--add-dir` input to absolute directories. The raw CLI skips an
 * entry it cannot resolve with a warning; here a directory that is not there
 * is refused, because a silently ignored typo reads as a granted fence until
 * the first denial says otherwise.
 *
 * @param {string[]} dirs   Raw paths, absolute or relative to `cwd`.
 * @param {string} cwd      Directory relative entries resolve against.
 * @returns {string[]}      Absolute paths, order preserved.
 */
export function resolveAdditionalDirectories(dirs, cwd = process.cwd()) {
  const base = path.resolve(String(cwd));
  return (Array.isArray(dirs) ? dirs : []).map((entry) => {
    let input;
    try {
      input = normalizeInput(entry);
    } catch (error) {
      throw new Error(`--add-dir ${String(entry)} is not a usable path: ${error.message}`);
    }
    const resolved = path.resolve(base, input);
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch {
      throw new Error(`--add-dir ${resolved} does not exist.`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`--add-dir ${resolved} is not a directory.`);
    }
    return resolved;
  });
}

/**
 * Tokens in free text that unambiguously name a filesystem location: a drive
 * letter, `~/`, `./`, `../`, or a leading slash. Deliberately NOT matched:
 * a bare `src/foo.js` (relative, so always inside), `Foo::bar`, `a/b` in prose.
 */
const PATH_TOKEN = /(?:^|[\s"'`(<[])((?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|\/(?!\/))[^\s"'`)>\],;]*)/g;

/**
 * Paths a prompt names that fall outside the fence.
 *
 * Only tokens that resolve to something that actually exists are reported: a
 * false positive blocks a legitimate prompt, while a miss costs nothing,
 * because that read was going to be denied anyway. The existence check is what
 * makes this safe to fail on.
 *
 * @param {string} text            The prompt, as the user wrote it.
 * @param {object|string} policy   Workspace policy or root.
 * @param {{limit?: number, exists?: (path: string) => boolean}} [options]
 *   `limit` caps the report (a pasted stack trace names hundreds).
 * @returns {{token: string, resolved: string}[]}
 */
export function findOutsidePathsInText(text, policy, options = {}) {
  const limit = options.limit ?? 20;
  const exists = options.exists ?? fs.existsSync;
  const source = typeof text === "string" ? text : "";
  const seen = new Set();
  const outside = [];

  for (const match of source.matchAll(PATH_TOKEN)) {
    // Trailing punctuation belongs to the sentence, not to the path.
    const token = match[1].replace(/[.,:;!?)\]]+$/, "");
    if (!token || seen.has(token)) continue;
    seen.add(token);
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) continue; // a URL, not a path
    if (token.startsWith("/dev/")) continue; // pseudo-device, never a real read

    let check;
    try {
      check = isInsideWorkspace(policy, token);
    } catch {
      continue;
    }
    if (check.inside || !check.resolved || !exists(check.resolved)) continue;

    outside.push({ token, resolved: check.resolved });
    if (outside.length >= limit) break;
  }

  return outside;
}

function toPolicy(rootOrPolicy, cwd) {
  if (rootOrPolicy && typeof rootOrPolicy === "object" && rootOrPolicy.rootCanonical) {
    // A hand-built policy from before --add-dir existed has no `roots`.
    const policy = rootOrPolicy.roots
      ? rootOrPolicy
      : { ...rootOrPolicy, roots: [{ resolved: rootOrPolicy.root, canonical: rootOrPolicy.rootCanonical }] };
    return cwd ? { ...policy, cwdCanonical: canonicalizePath(path.resolve(cwd)) } : policy;
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
 * @returns {{inside: boolean, resolved: string|null, relative: string|null, root: string|null, error: string|null}}
 *   `relative` is posix-separated, relative to the root that matched (`root`),
 *   and "" for that root itself. `inside` is always false when `error` is set:
 *   malformed input fails closed.
 */
export function isInsideWorkspace(root, candidate, opts = {}) {
  let policy;
  try {
    policy = toPolicy(root, opts.cwd);
  } catch (error) {
    return { inside: false, resolved: null, relative: null, root: null, error: `invalid workspace root: ${error.message}` };
  }

  let input;
  try {
    input = normalizeInput(candidate);
  } catch (error) {
    return { inside: false, resolved: null, relative: null, root: null, error: error.message };
  }

  const resolvedRaw = path.resolve(policy.cwdCanonical, input);

  // A UNC candidate on a different share cannot be inside a workspace on this
  // one, and realpath on an unreachable share stalls on a network lookup.
  // Decide it without touching the network.
  if (isUncPath(resolvedRaw)) {
    const candidateRoot = compareKey(path.parse(resolvedRaw).root);
    const onSomeShare = policy.roots.some(
      (entry) => compareKey(path.parse(entry.canonical).root) === candidateRoot
    );
    if (!onSomeShare) {
      return { inside: false, resolved: resolvedRaw, relative: null, root: null, error: null };
    }
  }

  const resolved = canonicalizePath(resolvedRaw);
  // The workspace root first, then each --add-dir. `relative` is taken from
  // the root that matched, so the protected-path rules (.git, CI workflows,
  // hooks) cover an added directory exactly as they cover the workspace.
  for (const entry of policy.roots) {
    if (isContained(entry.canonical, resolved)) {
      return {
        inside: true,
        resolved,
        relative: toPosixRelative(entry.canonical, resolved),
        root: entry.canonical,
        error: null
      };
    }
  }
  return { inside: false, resolved, relative: null, root: null, error: null };
}

/**
 * A workspace root so wide that "inside the workspace" stops meaning anything:
 * the home directory, an ancestor of it, or a filesystem/drive root. A job
 * launched from one of these with --write would be allowed to edit
 * everything the user owns. Malformed input counts as wide (fail closed).
 */
export function isWideRoot(root) {
  if (typeof root !== "string" || root.trim() === "") {
    return true;
  }
  let canonical;
  let home;
  try {
    canonical = canonicalizePath(path.resolve(root));
    home = canonicalizePath(path.resolve(os.homedir()));
  } catch {
    return true;
  }
  const rootKey = compareKey(canonical);
  const homeKey = compareKey(home);
  if (rootKey === homeKey) return true;
  if (homeKey.startsWith(rootKey.endsWith(path.sep) ? rootKey : `${rootKey}${path.sep}`)) return true;
  return rootKey === compareKey(path.parse(canonical).root);
}
