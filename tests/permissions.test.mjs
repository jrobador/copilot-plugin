import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createPermissionHandler,
  decidePermission,
  describeRequest,
  normalizeMode,
  READ_ONLY,
  WORKSPACE_WRITE
} from "../plugins/copilot/scripts/lib/permissions.mjs";

const shell = (overrides = {}) => ({
  kind: "shell",
  fullCommandText: "git status",
  commands: [{ identifier: "git status", readOnly: true }],
  hasWriteFileRedirection: false,
  canOfferSessionApproval: true,
  intention: "inspect the tree",
  possiblePaths: [],
  possibleUrls: [],
  ...overrides
});

describe("normalizeMode", () => {
  it("defaults to read-only", () => {
    assert.equal(normalizeMode(undefined), READ_ONLY);
    assert.equal(normalizeMode(null), READ_ONLY);
    assert.equal(normalizeMode("nonsense"), READ_ONLY);
  });

  it("maps the --write boolean onto workspace-write", () => {
    assert.equal(normalizeMode(true), WORKSPACE_WRITE);
    assert.equal(normalizeMode(false), READ_ONLY);
  });
});

describe("decidePermission: read-only jobs", () => {
  it("allows reads", () => {
    const result = decidePermission({ kind: "read", path: "src/index.js" }, READ_ONLY);
    assert.equal(result.allowed, true);
    assert.equal(result.decision.kind, "approve-once");
  });

  it("refuses writes", () => {
    const result = decidePermission({ kind: "write", fileName: "src/index.js" }, READ_ONLY);
    assert.equal(result.allowed, false);
    assert.equal(result.decision.kind, "reject");
    assert.match(result.reason, /read-only/);
  });

  it("allows a shell command the runtime classified as read-only", () => {
    assert.equal(decidePermission(shell(), READ_ONLY).allowed, true);
  });

  it("refuses a shell command that can mutate state", () => {
    const request = shell({
      fullCommandText: "git status && rm -rf build",
      commands: [
        { identifier: "git status", readOnly: true },
        { identifier: "rm", readOnly: false }
      ]
    });
    const result = decidePermission(request, READ_ONLY);
    assert.equal(result.allowed, false);
    assert.match(result.reason, /rm/);
  });

  it("refuses a read-only command that redirects into a file", () => {
    const request = shell({
      fullCommandText: "cat config > /etc/hosts",
      hasWriteFileRedirection: true
    });
    assert.equal(decidePermission(request, READ_ONLY).allowed, false);
  });

  it("refuses a shell command the runtime could not classify", () => {
    const request = shell({ commands: [] });
    const result = decidePermission(request, READ_ONLY);
    assert.equal(result.allowed, false);
    assert.match(result.reason, /could not classify/);
  });

  it("refuses network access", () => {
    const result = decidePermission({ kind: "url", url: "https://example.com" }, READ_ONLY);
    assert.equal(result.allowed, false);
  });

  it("allows an MCP tool that declares itself read-only", () => {
    const request = { kind: "mcp", readOnly: true, serverName: "docs", toolName: "search" };
    assert.equal(decidePermission(request, READ_ONLY).allowed, true);
  });

  it("refuses an MCP tool that does not", () => {
    const request = { kind: "mcp", readOnly: false, serverName: "jira", toolName: "create_issue" };
    assert.equal(decidePermission(request, READ_ONLY).allowed, false);
  });
});

describe("decidePermission: write-capable jobs", () => {
  it("allows writes", () => {
    const result = decidePermission({ kind: "write", fileName: "src/index.js" }, WORKSPACE_WRITE);
    assert.equal(result.allowed, true);
  });

  it("allows mutating shell commands", () => {
    const request = shell({
      fullCommandText: "npm install",
      commands: [{ identifier: "npm", readOnly: false }]
    });
    assert.equal(decidePermission(request, WORKSPACE_WRITE).allowed, true);
  });
});

describe("decidePermission: refused in every mode", () => {
  it("refuses a sandbox bypass even with --write", () => {
    const request = shell({ requestSandboxBypass: true, requestSandboxBypassReason: "need root" });
    for (const mode of [READ_ONLY, WORKSPACE_WRITE]) {
      const result = decidePermission(request, mode);
      assert.equal(result.allowed, false, `expected denial in ${mode}`);
      assert.match(result.reason, /Sandbox bypass/);
    }
  });

  it("refuses memory writes, which would outlive the job unseen", () => {
    for (const mode of [READ_ONLY, WORKSPACE_WRITE]) {
      assert.equal(decidePermission({ kind: "memory", fact: "x" }, mode).allowed, false);
    }
  });

  it("fails closed on an unrecognized request kind", () => {
    const result = decidePermission({ kind: "some-future-capability" }, WORKSPACE_WRITE);
    assert.equal(result.allowed, false);
    assert.match(result.reason, /unrecognized/);
  });

  it("fails closed on a malformed request", () => {
    assert.equal(decidePermission(undefined, WORKSPACE_WRITE).allowed, false);
  });
});

describe("createPermissionHandler", () => {
  it("returns the SDK decision and reports it to the observer", () => {
    const seen = [];
    const handler = createPermissionHandler(READ_ONLY, (entry) => seen.push(entry));

    const decision = handler({ kind: "write", fileName: "src/index.js" });

    assert.equal(decision.kind, "reject");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].allowed, false);
    assert.equal(seen[0].kind, "write");
    assert.equal(seen[0].mode, READ_ONLY);
    assert.match(seen[0].request, /src\/index\.js/);
  });

  it("works without an observer", () => {
    const handler = createPermissionHandler(WORKSPACE_WRITE);
    assert.equal(handler({ kind: "read", path: "a.js" }).kind, "approve-once");
  });
});

describe("describeRequest", () => {
  it("summarizes each request kind", () => {
    assert.equal(describeRequest(shell()), "shell: git status");
    assert.equal(describeRequest({ kind: "write", fileName: "a.js" }), "write: a.js");
    assert.equal(describeRequest({ kind: "read", path: "a.js" }), "read: a.js");
    assert.equal(describeRequest({ kind: "url", url: "https://x.dev" }), "url: https://x.dev");
    assert.equal(describeRequest(undefined), "unknown");
  });
});
