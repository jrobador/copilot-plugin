import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  renderSetupReport,
  renderReviewResult,
  renderTaskResult,
  renderStatusReport,
  renderStoredJobResult,
  renderCancelReport
} from "../plugins/copilot/scripts/lib/render.mjs";

describe("renderSetupReport", () => {
  it("renders ready report", () => {
    const output = renderSetupReport({
      ready: true,
      node: { detail: "v22.0.0" },
      npm: { detail: "10.0.0" },
      copilot: { detail: "1.0.0" },
      auth: { detail: "authenticated" },
      sessionRuntime: { label: "direct startup" },
      reviewGateEnabled: false,
      actionsTaken: [],
      nextSteps: []
    });
    assert.match(output, /Copilot Setup/);
    assert.match(output, /ready/);
  });
});

describe("renderReviewResult", () => {
  it("renders parsed review", () => {
    const output = renderReviewResult(
      {
        parsed: {
          verdict: "needs-attention",
          summary: "Found issues",
          findings: [
            { severity: "high", title: "Bug", body: "Details", file: "a.js", line_start: 1, line_end: 5, confidence: 0.9, recommendation: "Fix it" }
          ],
          next_steps: ["Fix bug"]
        },
        rawOutput: ""
      },
      { reviewLabel: "Adversarial Review", targetLabel: "working tree", reasoningSummary: [] }
    );
    assert.match(output, /Copilot Adversarial Review/);
    assert.match(output, /needs-attention/);
    assert.match(output, /\[high\]/);
  });

  it("renders parse error gracefully", () => {
    const output = renderReviewResult(
      { parsed: null, parseError: "bad json", rawOutput: "garbage" },
      { reviewLabel: "Review", targetLabel: "branch", reasoningSummary: [] }
    );
    assert.match(output, /bad json/);
  });
});

describe("renderTaskResult", () => {
  it("renders raw output", () => {
    const output = renderTaskResult({ rawOutput: "Task done." }, {});
    assert.equal(output, "Task done.\n");
  });

  it("renders failure message", () => {
    const output = renderTaskResult({ rawOutput: "", failureMessage: "Failed" }, {});
    assert.equal(output, "Failed\n");
  });
});

describe("renderStatusReport", () => {
  it("renders empty status", () => {
    const output = renderStatusReport({
      sessionRuntime: { label: "direct startup" },
      config: { stopReviewGate: false },
      running: [],
      latestFinished: null,
      recent: [],
      needsReview: false
    });
    assert.match(output, /Copilot Status/);
    assert.match(output, /No jobs recorded/);
  });
});

describe("renderStoredJobResult", () => {
  it("renders stored result with session id", () => {
    const output = renderStoredJobResult(
      { id: "job-1", status: "completed", title: "Task" },
      { result: { rawOutput: "Done." }, sessionId: "sess-1" }
    );
    assert.match(output, /Done/);
  });
});

describe("renderCancelReport", () => {
  it("renders cancel report", () => {
    const output = renderCancelReport({ id: "job-1", title: "Task", summary: "Fix bug" });
    assert.match(output, /Copilot Cancel/);
    assert.match(output, /job-1/);
  });
});
