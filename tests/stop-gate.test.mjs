import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { createTempWorkspace, cleanupDir } from "./helpers.mjs";
import { getConfig, setConfig } from "../lib/state.mjs";
import {
  applyBlockBudget,
  blockPayload,
  decideStop,
  GATE_MAX_CONSECUTIVE_BLOCKS,
  parseStopReviewOutput,
  resolveHookCwd,
  runStopReview
} from "../bin/stop-review-gate-hook.mjs";

const child = (overrides = {}) => ({ status: 0, stdout: "", stderr: "", error: undefined, ...overrides });
const answering = (rawOutput) => () => child({ stdout: JSON.stringify({ rawOutput }) });

describe("stop gate: parseStopReviewOutput", () => {
  it("reads ALLOW and BLOCK from the first line", () => {
    assert.equal(parseStopReviewOutput("ALLOW: nothing to review").ok, true);
    const blocked = parseStopReviewOutput("BLOCK: the retry loop never terminates\nmore detail");
    assert.equal(blocked.ok, false);
    assert.match(blocked.reason, /never terminates/);
  });

  it("treats an empty or unexpected answer as not ok and not blocked", () => {
    for (const answer of ["", "I think it is fine"]) {
      const review = parseStopReviewOutput(answer);
      assert.equal(review.ok, false);
      assert.equal(review.blocked, false);
    }
    assert.equal(parseStopReviewOutput("BLOCK: x").blocked, true);
    assert.equal(parseStopReviewOutput("ALLOW: y").blocked, false);
  });
});

describe("stop gate: runStopReview", () => {
  it("passes the marker and the previous Claude response to the task", () => {
    let seen = null;
    const spawnImpl = (_exec, args, options) => {
      seen = { args, options };
      return child({ stdout: JSON.stringify({ rawOutput: "ALLOW: ok" }) });
    };

    const review = runStopReview(process.cwd(), { session_id: "s-1", last_assistant_message: "I edited foo.js" }, { spawnImpl });

    assert.equal(review.ok, true);
    assert.equal(seen.args[1], "task");
    assert.match(seen.args[3], /Run a stop-gate review of the previous Claude turn/);
    assert.match(seen.args[3], /I edited foo\.js/);
    assert.equal(seen.options.env.COPILOT_PLUGIN_SESSION_ID, "s-1");
  });

  it("blocks on an explicit BLOCK verdict", () => {
    const review = runStopReview(process.cwd(), {}, { spawnImpl: answering("BLOCK: tests still fail") });
    assert.equal(review.ok, false);
    const stop = decideStop(review, "Copilot task x is still running.");
    assert.equal(stop.decision, "block");
    assert.match(stop.reason, /still running/);
    assert.match(stop.reason, /tests still fail/);
  });

  it("lets the stop proceed on ALLOW", () => {
    const review = runStopReview(process.cwd(), {}, { spawnImpl: answering("ALLOW: no edits this turn") });
    assert.equal(decideStop(review), null);
  });

  // Audit M3 / task P1-3. Every failure to *run* the review (Copilot logged
  // out, rate limited, timed out, garbled output) used to block the stop,
  // which turned an infrastructure problem into a Claude/Copilot loop.
  for (const [label, spawnImpl] of [
    ["the task exits non-zero", () => child({ status: 1, stderr: "Copilot is not authenticated" })],
    ["the task times out", () => child({ status: null, error: Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" }) })],
    ["the task prints invalid JSON", () => child({ stdout: "not json" })],
    ["the task returns no final message", answering("")]
  ]) {
    it(`does not block the stop when ${label}`, () => {
      const review = runStopReview(process.cwd(), {}, { spawnImpl });
      assert.equal(review.ok, false, "the review did not succeed");
      assert.equal(review.blocked, false);
      assert.match(review.reason, /not blocked|manually/);
      assert.equal(decideStop(review), null, `expected no block decision; got ${JSON.stringify(decideStop(review))}`);
    });
  }
});

// Cross-host: the stop hook runs under Claude Code and Cursor, which name
// their stdin fields differently.
describe("stop gate: cross-host input/output", () => {
  it("resolveHookCwd reads the workspace from either host's fields", () => {
    assert.equal(resolveHookCwd({ cwd: "/a" }), "/a");
    assert.equal(resolveHookCwd({ workspacePath: "/b" }), "/b");
    assert.equal(resolveHookCwd({ workspace_roots: ["/c", "/d"] }), "/c");
    assert.equal(typeof resolveHookCwd({}), "string");
  });

  it("blockPayload carries both hosts' block shapes", () => {
    const p = blockPayload("tests still fail");
    assert.equal(p.decision, "block"); // Claude Code
    assert.equal(p.reason, "tests still fail");
    assert.equal(p.permission, "deny"); // Cursor
    assert.equal(p.agent_message, "tests still fail");
  });
});

describe("stop gate: block budget", () => {
  let repo;
  let previousDataDir;

  before(() => {
    repo = createTempWorkspace();
    execSync("git init", { cwd: repo });
    fs.writeFileSync(path.join(repo, "f.txt"), "x\n");
    previousDataDir = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = path.join(repo, ".plugin-data");
    setConfig(repo, "stopReviewGate", true);
  });

  after(() => {
    if (previousDataDir === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previousDataDir;
    cleanupDir(repo);
  });

  it("switches the gate off after consecutive blocks and resets on an allow", () => {
    assert.deepEqual(applyBlockBudget(repo, false), { count: 0, disabled: false });

    let last = null;
    for (let index = 1; index <= GATE_MAX_CONSECUTIVE_BLOCKS; index += 1) {
      last = applyBlockBudget(repo, true);
      assert.equal(last.count, index);
    }
    assert.equal(last.disabled, true);
    assert.equal(getConfig(repo).stopReviewGate, false, "the gate disables itself");
    assert.equal(getConfig(repo).gateConsecutiveBlocks, 0);

    setConfig(repo, "stopReviewGate", true);
    assert.equal(applyBlockBudget(repo, true).count, 1);
    assert.equal(applyBlockBudget(repo, false).count, 0, "an allow resets the streak");
    assert.equal(getConfig(repo).stopReviewGate, true);
  });
});
