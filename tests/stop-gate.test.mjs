import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { decideStop, parseStopReviewOutput, runStopReview } from "../plugins/copilot/scripts/stop-review-gate-hook.mjs";

const child = (overrides = {}) => ({ status: 0, stdout: "", stderr: "", error: undefined, ...overrides });
const answering = (rawOutput) => () => child({ stdout: JSON.stringify({ rawOutput }) });

describe("stop gate: parseStopReviewOutput", () => {
  it("reads ALLOW and BLOCK from the first line", () => {
    assert.equal(parseStopReviewOutput("ALLOW: nothing to review").ok, true);
    const blocked = parseStopReviewOutput("BLOCK: the retry loop never terminates\nmore detail");
    assert.equal(blocked.ok, false);
    assert.match(blocked.reason, /never terminates/);
  });

  it("treats an empty or unexpected answer as not ok", () => {
    assert.equal(parseStopReviewOutput("").ok, false);
    assert.equal(parseStopReviewOutput("I think it is fine").ok, false);
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
    assert.equal(seen.options.env.COPILOT_COMPANION_SESSION_ID, "s-1");
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
  // out, rate limited, timed out, garbled output) currently blocks the stop,
  // which turns an infrastructure problem into a Claude/Copilot loop.
  for (const [label, spawnImpl] of [
    ["the task exits non-zero", () => child({ status: 1, stderr: "Copilot is not authenticated" })],
    ["the task times out", () => child({ status: null, error: Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" }) })],
    ["the task prints invalid JSON", () => child({ stdout: "not json" })],
    ["the task returns no final message", answering("")]
  ]) {
    it(`does not block the stop when ${label}`, { todo: "P1-3: only an explicit BLOCK verdict blocks; infrastructure failures are logged" }, () => {
      const review = runStopReview(process.cwd(), {}, { spawnImpl });
      assert.equal(review.ok, false, "the review did not succeed");
      assert.equal(decideStop(review), null, `expected no block decision; got ${JSON.stringify(decideStop(review))}`);
    });
  }
});
