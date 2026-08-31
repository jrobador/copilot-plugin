import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";

import { createTempWorkspace, cleanupDir } from "./helpers.mjs";
import {
  assertSafeRef,
  ensureGitRepository,
  getRepoRoot,
  MAX_DIFF_BYTES,
  truncateDiff,
  detectDefaultBranch,
  getCurrentBranch,
  getWorkingTreeState,
  resolveReviewTarget,
  collectReviewContext
} from "../lib/git.mjs";

describe("git", () => {
  let tempDir;

  before(() => {
    tempDir = createTempWorkspace();
    execSync("git init", { cwd: tempDir });
    execSync("git config user.email test@test.com", { cwd: tempDir });
    execSync("git config user.name Test", { cwd: tempDir });
    fs.writeFileSync(path.join(tempDir, "file.txt"), "hello");
    execSync("git add . && git commit -m init", { cwd: tempDir });
  });

  after(() => cleanupDir(tempDir));

  it("ensureGitRepository returns repo root", () => {
    const root = ensureGitRepository(tempDir);
    assert.ok(root);
  });

  it("ensureGitRepository throws outside repo", () => {
    const nonRepo = createTempWorkspace();
    assert.throws(() => ensureGitRepository(nonRepo), /Git repository/);
    cleanupDir(nonRepo);
  });

  it("getRepoRoot returns root", () => {
    const root = getRepoRoot(tempDir);
    assert.ok(root);
  });

  it("getCurrentBranch returns branch name", () => {
    const branch = getCurrentBranch(tempDir);
    assert.ok(branch);
  });

  it("getWorkingTreeState returns clean state", () => {
    const state = getWorkingTreeState(tempDir);
    assert.equal(state.isDirty, false);
  });

  it("getWorkingTreeState detects dirty state", () => {
    fs.writeFileSync(path.join(tempDir, "dirty.txt"), "dirty");
    const state = getWorkingTreeState(tempDir);
    assert.equal(state.isDirty, true);
    fs.unlinkSync(path.join(tempDir, "dirty.txt"));
  });

  it("resolveReviewTarget auto-detects working tree when dirty", () => {
    fs.writeFileSync(path.join(tempDir, "new.txt"), "new");
    const target = resolveReviewTarget(tempDir);
    assert.equal(target.mode, "working-tree");
    fs.unlinkSync(path.join(tempDir, "new.txt"));
  });

  it("resolveReviewTarget respects explicit scope", () => {
    const target = resolveReviewTarget(tempDir, { scope: "working-tree" });
    assert.equal(target.mode, "working-tree");
    assert.equal(target.explicit, true);
  });

  it("resolveReviewTarget respects explicit base", () => {
    const target = resolveReviewTarget(tempDir, { base: "HEAD" });
    assert.equal(target.mode, "branch");
    assert.equal(target.baseRef, "HEAD");
  });

  it("collectReviewContext returns context for working-tree", () => {
    fs.writeFileSync(path.join(tempDir, "review.txt"), "review me");
    const target = resolveReviewTarget(tempDir, { scope: "working-tree" });
    const context = collectReviewContext(tempDir, target);
    assert.equal(context.mode, "working-tree");
    assert.ok(context.content);
    fs.unlinkSync(path.join(tempDir, "review.txt"));
  });

  // Audit H1 / task P0-1. Git accepts `|`, `&`, `;` and `$()` in ref names, and
  // the default branch name comes from the remote. Refs are validated before
  // they are handed to any process.
  it("assertSafeRef rejects refs carrying shell metacharacters or looking like options", () => {
    for (const bad of ["main|calc", "main&calc", "main;calc", "main$(x)", "main`x`", "a b", "--output=x", "", "  "]) {
      assert.throws(() => assertSafeRef(bad), /unsafe|invalid/i, JSON.stringify(bad));
    }
    for (const good of ["main", "origin/main", "feature/x-1", "v1.2.3", "HEAD"]) {
      assert.equal(assertSafeRef(good), good);
      assert.equal(assertSafeRef(good, tempDir), good);
    }
    // With a cwd, git's own rules apply too.
    assert.throws(() => assertSafeRef("bad..ref", tempDir), /invalid ref/);
  });

  it("resolveReviewTarget refuses an unsafe --base", () => {
    assert.throws(() => resolveReviewTarget(tempDir, { base: "main|calc" }), /unsafe ref/);
  });

  it("detectDefaultBranch refuses a remote HEAD whose name is unsafe", () => {
    // execFileSync: the ref itself must not go through a shell in the test
    // either. `&` rather than `|`: NTFS refuses `|` in a loose ref's filename
    // (a clone would still deliver it through packed-refs), while `&` is a
    // legal filename character and a cmd.exe command separator.
    const gitArgs = (...args) => execFileSync("git", args, { cwd: tempDir, stdio: "ignore" });
    gitArgs("update-ref", "refs/remotes/origin/main&calc", "HEAD");
    gitArgs("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main&calc");
    try {
      assert.throws(() => detectDefaultBranch(tempDir), /unsafe ref/);
    } finally {
      gitArgs("symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
      gitArgs("update-ref", "-d", "refs/remotes/origin/main&calc");
    }
  });

  // Audit M5 / task P1-5. The diff used to be pasted whole into the prompt;
  // only untracked files had a size cap. A 1 MB change to a tracked file is
  // truncated with a marker instead of shipped verbatim.
  it("collectReviewContext caps the diff size and marks the truncation", () => {
    const big = path.join(tempDir, "file.txt");
    const original = fs.readFileSync(big);
    fs.writeFileSync(big, "x".repeat(1024 * 1024));
    try {
      const target = resolveReviewTarget(tempDir, { scope: "working-tree" });
      const context = collectReviewContext(tempDir, target);
      assert.ok(context.content.length < MAX_DIFF_BYTES + 4096, `content is ${context.content.length} bytes`);
      assert.match(context.content, /truncated: \d+ bytes omitted/);
      assert.match(context.content, /diff --git a\/file\.txt/, "the file header survives");
    } finally {
      fs.writeFileSync(big, original);
    }
  });

  it("truncateDiff keeps small diffs intact, drops lockfile bodies, and budgets across files", () => {
    const small = "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-x\n+y\n";
    assert.equal(truncateDiff(small), small);

    const lock = "diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n-1\n+2\n";
    assert.match(truncateDiff(lock), /lockfile: body omitted/);
    assert.doesNotMatch(truncateDiff(lock), /\+2/);

    const oneFile = (name, size) => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n+${"z".repeat(size)}\n`;
    const many = Array.from({ length: 8 }, (_, index) => oneFile(`f${index}.js`, 39_000)).join("");
    const result = truncateDiff(many);
    assert.ok(Buffer.byteLength(result, "utf8") < MAX_DIFF_BYTES + 8 * 200, `result is ${result.length} bytes`);
    assert.match(result, /file\(s\) exceeded the \d+-byte diff budget/);
    for (let index = 0; index < 8; index += 1) {
      assert.match(result, new RegExp(`diff --git a/f${index}\\.js`), "every file is still named");
    }
  });
});
