import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  renderSetupReport,
  renderDegradedBanner,
  renderReviewResult,
  renderTaskResult,
  renderStatusReport,
  renderStoredJobResult,
  renderCancelReport
} from "../lib/render.mjs";

describe("renderSetupReport", () => {
  it("renders ready report", () => {
    const output = renderSetupReport({
      ready: true,
      node: { detail: "v22.0.0" },
      npm: { detail: "10.0.0" },
      copilot: { detail: "1.0.0" },
      auth: { detail: "authenticated" },
      models: ["opus", "sonnet", "gpt-5.4"],
      sessionRuntime: { label: "direct startup" },
      reviewGateEnabled: false,
      actionsTaken: [],
      nextSteps: []
    });
    assert.match(output, /Copilot Setup/);
    assert.match(output, /ready/);
    assert.match(output, /models \(3\): opus, sonnet, gpt-5\.4/);
    assert.match(output, /allowed programs \(every mode\): defaults only/);
  });

  it("shows no models when the account is not signed in", () => {
    const output = renderSetupReport({
      ready: false,
      node: { detail: "v22" },
      npm: { detail: "10" },
      copilot: { detail: "x" },
      auth: { detail: "not authenticated" },
      models: [],
      sessionRuntime: { label: "SDK managed" },
      reviewGateEnabled: false,
      actionsTaken: [],
      nextSteps: []
    });
    assert.match(output, /models \(0\): none/);
  });

  it("lists extra programs allowed for run_command", () => {
    const output = renderSetupReport({
      ready: true,
      node: { detail: "v22.0.0" },
      npm: { detail: "10.0.0" },
      copilot: { detail: "1.0.0" },
      auth: { detail: "authenticated" },
      sessionRuntime: { label: "direct startup" },
      reviewGateEnabled: false,
      extraPrograms: ["bun", "pytest"],
      actionsTaken: [],
      nextSteps: []
    });
    assert.match(output, /allowed programs \(every mode\): bun, pytest/);
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

  it("lists files changed and denied requests under the output", () => {
    const output = renderTaskResult(
      { rawOutput: "Done." },
      {
        touchedFiles: ["src/a.js"],
        denials: [{ request: "write: /etc/x", reason: "Refused to write /etc/x: outside the workspace." }]
      }
    );
    // A denial banners the output: the reader must not reach the conclusion
    // before learning the run was incomplete.
    assert.equal(
      output,
      "> **DEGRADED RUN** — 1 request was refused, so this run did not see everything it went looking for.\n> Treat the conclusion below as unverified. The refused requests are listed at the end.\n\n" +
        "Done.\n\nFiles changed:\n- src/a.js\n\nDenied:\n- write: /etc/x — Refused to write /etc/x: outside the workspace.\n"
    );
  });

  it("omits the footer when nothing was touched or denied", () => {
    assert.equal(renderTaskResult({ rawOutput: "Done." }, { touchedFiles: [], denials: [] }), "Done.\n");
  });

  it("flags an unfenced shell before the rest of the footer", () => {
    assert.equal(renderTaskResult({ rawOutput: "Done." }, { unsafeShell: true }), "Done.\n\nShell: unfenced (--unsafe-shell)\n");
    const output = renderTaskResult(
      { rawOutput: "Done." },
      { unsafeShell: true, touchedFiles: ["src/a.js"], denials: [{ request: "command: node -e 1", reason: "no" }] }
    );
    assert.equal(
      output,
      "> **DEGRADED RUN** — 1 request was refused, so this run did not see everything it went looking for.\n> Treat the conclusion below as unverified. The refused requests are listed at the end.\n\n" +
        "Done.\n\nShell: unfenced (--unsafe-shell)\n\nFiles changed:\n- src/a.js\n\nDenied:\n- command: node -e 1 — no\n"
    );
  });

  it("shows denials even when Copilot returned no output", () => {
    const output = renderTaskResult({ rawOutput: "" }, { denials: [{ request: "read: ~/.ssh/id_rsa" }] });
    assert.match(output, /did not return a final message/);
    assert.match(output, /Denied:\n- read: ~\/\.ssh\/id_rsa/);
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

  it("rebuilds the permission footer from the stored payload", () => {
    const output = renderStoredJobResult(
      { id: "job-1", status: "completed", title: "Task" },
      {
        result: {
          rawOutput: "Done.",
          touchedFiles: ["src/a.js"],
          denials: [{ request: "write: /etc/x", reason: "outside" }]
        },
        threadId: "sess-1"
      }
    );
    assert.match(output, /Done\.\n\nFiles changed:\n- src\/a\.js\n\nDenied:\n- write: \/etc\/x — outside\n/);
    assert.match(output, /Copilot session ID: sess-1/);
  });

  it("shows an unfenced shell from the stored payload", () => {
    const output = renderStoredJobResult(
      { id: "job-1", status: "completed", title: "Task" },
      { result: { rawOutput: "Done.", unsafeShell: true }, threadId: null }
    );
    assert.equal(output, "Done.\n\nShell: unfenced (--unsafe-shell)\n");
  });
});

describe("renderCancelReport", () => {
  it("renders cancel report", () => {
    const output = renderCancelReport({ id: "job-1", title: "Task", summary: "Fix bug" });
    assert.match(output, /Copilot Cancel/);
    assert.match(output, /job-1/);
  });
});

describe("renderDegradedBanner and the review verdict", () => {
  const parsed = (verdict = "approve", findings = []) => ({
    parsed: { verdict, summary: "Looks fine.", findings, next_steps: [] },
    rawOutput: "",
    parseError: null
  });
  const meta = (denials) => ({ reviewLabel: "Review", targetLabel: "working tree", denials });

  it("says nothing when nothing was refused", () => {
    assert.equal(renderDegradedBanner([]), "");
    assert.equal(renderDegradedBanner(undefined), "");
    const output = renderReviewResult(parsed(), meta([]));
    assert.match(output, /Verdict: approve/);
    assert.match(output, /No material findings\./);
    assert.doesNotMatch(output, /DEGRADED/);
  });

  it("invalidates a clean verdict reached without part of the evidence", () => {
    const output = renderReviewResult(parsed(), meta([{ request: "read: src/secret.js", reason: "outside the workspace" }]));
    assert.match(output, /DEGRADED RUN/);
    assert.match(output, /Verdict: unreliable — the model said "approve"/);
    // "No findings" from a review that could not read the code is not a result.
    assert.doesNotMatch(output, /No material findings\./);
    assert.match(output, /that is not evidence that there is nothing wrong/);
    assert.match(output, /Denied:\n- read: src\/secret\.js/);
  });
});
