import fs from "node:fs";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";
import { runCommand, runCommandChecked } from "./process.mjs";

const MAX_UNTRACKED_BYTES = 24 * 1024;

/**
 * The diff goes into the prompt whole, next to a directory attachment that
 * lets Copilot open any file it wants. Past these sizes the diff stops helping
 * and starts costing: a lockfile churn or a generated asset would otherwise
 * fill the context on its own.
 */
export const MAX_DIFF_BYTES = 200_000;
export const MAX_FILE_DIFF_BYTES = 40_000;

/** Files whose diff body is never worth reading; they stay in --stat only. */
const LOCKFILE_PATTERN = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock)$/;

/** Sizes are reported in the marker so the reader knows what was left out. */
function truncationMarker(omitted) {
  return `(truncated: ${omitted} bytes omitted; open the file to see the rest)`;
}

/**
 * Cap a unified diff per file and in total, keeping every file's header so
 * the reader still learns which files changed.
 *
 * @param {string} diff
 * @returns {string}
 */
export function truncateDiff(diff) {
  const text = String(diff ?? "");
  if (!text) return text;

  const chunks = text.split(/^(?=diff --git )/m);
  const kept = [];
  let total = 0;
  let droppedFiles = 0;

  for (const chunk of chunks) {
    const headerLine = chunk.split("\n", 1)[0];
    const fileMatch = headerLine.match(/^diff --git a\/(.+?) b\//);
    const fileName = fileMatch ? fileMatch[1] : null;
    let body = chunk;

    if (fileName && LOCKFILE_PATTERN.test(fileName)) {
      body = `${headerLine}\n(lockfile: body omitted)\n`;
    } else if (Buffer.byteLength(body, "utf8") > MAX_FILE_DIFF_BYTES) {
      const omitted = Buffer.byteLength(body, "utf8") - MAX_FILE_DIFF_BYTES;
      body = `${body.slice(0, MAX_FILE_DIFF_BYTES)}\n${truncationMarker(omitted)}\n`;
    }

    const size = Buffer.byteLength(body, "utf8");
    if (total + size > MAX_DIFF_BYTES) {
      droppedFiles += 1;
      // Keep the header so the file is at least named.
      kept.push(`${headerLine}\n${truncationMarker(size)}\n`);
      continue;
    }
    kept.push(body);
    total += size;
  }

  if (droppedFiles > 0) {
    kept.push(`\n(truncated: ${droppedFiles} file(s) exceeded the ${MAX_DIFF_BYTES}-byte diff budget; open them directly)\n`);
  }
  return kept.join("");
}

function git(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, ...options });
}

function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", args, { cwd, ...options });
}

export function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (errorCode === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return result.stdout.trim();
}

export function getRepoRoot(cwd) {
  return gitChecked(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
}

/**
 * Characters git allows in a ref name but no process boundary should see:
 * shell metacharacters, quotes, whitespace. A ref also must not look like an
 * option, or git itself would parse it as one.
 */
const UNSAFE_REF_CHARS = /[\s&|;<>^$()%!`"'\\]/;

/**
 * Validate a ref before it is handed to any process. Refs come from the user
 * (`--base`) and from the remote (`origin/HEAD`), so the check is the only
 * thing between a hostile branch name and a command line.
 *
 * @param {unknown} ref
 * @param {string} [cwd]  When given, git's own `check-ref-format` runs too.
 * @returns {string} The ref, trimmed.
 */
export function assertSafeRef(ref, cwd) {
  const text = String(ref ?? "").trim();
  if (!text || text.startsWith("-") || UNSAFE_REF_CHARS.test(text)) {
    throw new Error(
      `Refusing to use ${JSON.stringify(String(ref))} as a git ref: it is empty, looks like an option, or contains shell metacharacters (unsafe ref).`
    );
  }
  if (cwd) {
    const check = git(cwd, ["check-ref-format", "--allow-onelevel", text]);
    if (check.status !== 0 && !check.error) {
      throw new Error(`${JSON.stringify(text)} is not a valid git ref name (invalid ref).`);
    }
  }
  return text;
}

export function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      // The remote chose this name. Validate it like user input.
      return assertSafeRef(remoteHead.replace("refs/remotes/origin/", ""), cwd);
    }
  }

  const candidates = ["main", "master", "trunk"];
  for (const candidate of candidates) {
    const local = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (local.status === 0) {
      return candidate;
    }
    const remote = git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]);
    if (remote.status === 0) {
      return `origin/${candidate}`;
    }
  }

  throw new Error("Unable to detect the repository default branch. Pass --base <ref> or use --scope working-tree.");
}

export function getCurrentBranch(cwd) {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}

export function getWorkingTreeState(cwd) {
  const staged = gitChecked(cwd, ["diff", "--cached", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const unstaged = gitChecked(cwd, ["diff", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const untracked = gitChecked(cwd, ["ls-files", "--others", "--exclude-standard"]).stdout.trim().split("\n").filter(Boolean);

  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0
  };
}

export function resolveReviewTarget(cwd, options = {}) {
  ensureGitRepository(cwd);

  const requestedScope = options.scope ?? "auto";
  const baseRef = options.base ? assertSafeRef(options.base, cwd) : null;
  const state = getWorkingTreeState(cwd);
  const supportedScopes = new Set(["auto", "working-tree", "branch"]);

  if (baseRef) {
    return {
      mode: "branch",
      label: `branch diff against ${baseRef}`,
      baseRef,
      explicit: true
    };
  }

  if (requestedScope === "working-tree") {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true
    };
  }

  if (!supportedScopes.has(requestedScope)) {
    throw new Error(
      `Unsupported review scope "${requestedScope}". Use one of: auto, working-tree, branch, or pass --base <ref>.`
    );
  }

  if (requestedScope === "branch") {
    const detectedBase = detectDefaultBranch(cwd);
    return {
      mode: "branch",
      label: `branch diff against ${detectedBase}`,
      baseRef: detectedBase,
      explicit: true
    };
  }

  if (state.isDirty) {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: false
    };
  }

  const detectedBase = detectDefaultBranch(cwd);
  return {
    mode: "branch",
    label: `branch diff against ${detectedBase}`,
    baseRef: detectedBase,
    explicit: false
  };
}

function formatSection(title, body) {
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join("\n");
}

function formatUntrackedFile(cwd, relativePath) {
  const absolutePath = path.join(cwd, relativePath);
  // lstat, not stat: an untracked symlink pointing at ~/.aws/credentials would
  // otherwise be read through and pasted into the prompt we send the model
  // provider. Only regular files inside the repository are ever read.
  const stat = fs.lstatSync(absolutePath);
  if (!stat.isFile()) {
    const kind = stat.isSymbolicLink() ? "symlink" : "not a regular file";
    return `### ${relativePath}\n(skipped: ${kind})`;
  }
  if (stat.size > MAX_UNTRACKED_BYTES) {
    return `### ${relativePath}\n(skipped: ${stat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit)`;
  }

  const buffer = fs.readFileSync(absolutePath);
  if (!isProbablyText(buffer)) {
    return `### ${relativePath}\n(skipped: binary file)`;
  }

  return [`### ${relativePath}`, "```", buffer.toString("utf8").trimEnd(), "```"].join("\n");
}

function collectWorkingTreeContext(cwd, state) {
  const status = gitChecked(cwd, ["status", "--short"]).stdout.trim();
  // No --binary: a base85 patch of an image is noise in a prompt.
  const stagedDiff = truncateDiff(gitChecked(cwd, ["diff", "--cached", "--no-ext-diff", "--submodule=diff"]).stdout);
  const unstagedDiff = truncateDiff(gitChecked(cwd, ["diff", "--no-ext-diff", "--submodule=diff"]).stdout);
  const untrackedBody = state.untracked.map((file) => formatUntrackedFile(cwd, file)).join("\n\n");

  const parts = [
    formatSection("Git Status", status),
    formatSection("Staged Diff", stagedDiff),
    formatSection("Unstaged Diff", unstagedDiff),
    formatSection("Untracked Files", untrackedBody)
  ];

  return {
    mode: "working-tree",
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    content: parts.join("\n")
  };
}

function collectBranchContext(cwd, baseRef) {
  const mergeBase = gitChecked(cwd, ["merge-base", "HEAD", baseRef]).stdout.trim();
  const commitRange = `${mergeBase}..HEAD`;
  const currentBranch = getCurrentBranch(cwd);
  const logOutput = gitChecked(cwd, ["log", "--oneline", "--decorate", commitRange]).stdout.trim();
  const diffStat = gitChecked(cwd, ["diff", "--stat", commitRange]).stdout.trim();
  const diff = truncateDiff(gitChecked(cwd, ["diff", "--no-ext-diff", "--submodule=diff", commitRange]).stdout);

  return {
    mode: "branch",
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${mergeBase}.`,
    content: [
      formatSection("Commit Log", logOutput),
      formatSection("Diff Stat", diffStat),
      formatSection("Branch Diff", diff)
    ].join("\n")
  };
}

export function collectReviewContext(cwd, target) {
  const repoRoot = getRepoRoot(cwd);
  const state = getWorkingTreeState(cwd);
  const currentBranch = getCurrentBranch(cwd);
  let details;

  if (target.mode === "working-tree") {
    details = collectWorkingTreeContext(repoRoot, state);
  } else {
    details = collectBranchContext(repoRoot, target.baseRef);
  }

  return {
    cwd: repoRoot,
    repoRoot,
    branch: currentBranch,
    target,
    ...details
  };
}
