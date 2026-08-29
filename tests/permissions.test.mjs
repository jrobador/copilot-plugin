import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  createPermissionHandler,
  decidePermission,
  describeRequest,
  normalizeMode,
  READ_ONLY,
  WORKSPACE_WRITE
} from "../plugins/copilot/scripts/lib/permissions.mjs";
import { cleanupDir, createTempWorkspace } from "./helpers.mjs";

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

// Every decision is judged against a real directory, so the containment
// checks below exercise the same realpath logic the runtime will.
let parent;
let ws;
let outsideFile;
let policy;

before(() => {
  parent = createTempWorkspace();
  ws = path.join(parent, "ws");
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  outsideFile = path.join(parent, "outside.txt");
  policy = { workspaceRoot: ws };
});
after(() => cleanupDir(parent));

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
  it("allows reads inside the workspace", () => {
    const result = decidePermission({ kind: "read", path: "src/index.js" }, READ_ONLY, policy);
    assert.equal(result.allowed, true);
    assert.equal(result.decision.kind, "approve-once");
    assert.equal(result.file, "src/index.js");
  });

  it("refuses writes", () => {
    const result = decidePermission({ kind: "write", fileName: "src/index.js" }, READ_ONLY, policy);
    assert.equal(result.allowed, false);
    assert.equal(result.decision.kind, "reject");
    assert.match(result.reason, /read-only/);
  });

  it("allows a shell command the runtime classified as read-only", () => {
    assert.equal(decidePermission(shell(), READ_ONLY, policy).allowed, true);
  });

  it("refuses a shell command that can mutate state", () => {
    const request = shell({
      fullCommandText: "git status && rm -rf build",
      commands: [
        { identifier: "git status", readOnly: true },
        { identifier: "rm", readOnly: false }
      ]
    });
    const result = decidePermission(request, READ_ONLY, policy);
    assert.equal(result.allowed, false);
    assert.match(result.reason, /rm/);
  });

  it("refuses a read-only command that redirects into a file", () => {
    const request = shell({
      fullCommandText: "cat config > out.txt",
      hasWriteFileRedirection: true
    });
    assert.equal(decidePermission(request, READ_ONLY, policy).allowed, false);
  });

  it("refuses a shell command the runtime could not classify", () => {
    const request = shell({ commands: [] });
    const result = decidePermission(request, READ_ONLY, policy);
    assert.equal(result.allowed, false);
    assert.match(result.reason, /could not classify/);
  });

  it("refuses network access", () => {
    const result = decidePermission({ kind: "url", url: "https://example.com" }, READ_ONLY, policy);
    assert.equal(result.allowed, false);
  });

  it("allows an MCP tool that declares itself read-only", () => {
    const request = { kind: "mcp", readOnly: true, serverName: "docs", toolName: "search" };
    assert.equal(decidePermission(request, READ_ONLY, policy).allowed, true);
  });

  it("refuses an MCP tool that does not", () => {
    const request = { kind: "mcp", readOnly: false, serverName: "jira", toolName: "create_issue" };
    assert.equal(decidePermission(request, READ_ONLY, policy).allowed, false);
  });
});

describe("decidePermission: write-capable jobs", () => {
  it("allows writes inside the workspace and reports the relative path", () => {
    const result = decidePermission({ kind: "write", fileName: "src/index.js" }, WORKSPACE_WRITE, policy);
    assert.equal(result.allowed, true);
    assert.equal(result.file, "src/index.js");
  });

  it("allows an absolute write inside the workspace", () => {
    const target = path.join(ws, "src", "new.js");
    const result = decidePermission({ kind: "write", fileName: target }, WORKSPACE_WRITE, policy);
    assert.equal(result.allowed, true);
    assert.equal(result.file, "src/new.js");
  });

  it("allows mutating shell commands", () => {
    const request = shell({
      fullCommandText: "npm install",
      commands: [{ identifier: "npm", readOnly: false }]
    });
    assert.equal(decidePermission(request, WORKSPACE_WRITE, policy).allowed, true);
  });

  it("allows a shell command whose paths are all inside or pseudo-devices", () => {
    const request = shell({
      fullCommandText: "git status 2>/dev/null; cat src/index.js",
      commands: [{ identifier: "git status", readOnly: true }],
      possiblePaths: ["/dev/null", "src/index.js", path.join(ws, "src")]
    });
    assert.equal(decidePermission(request, WORKSPACE_WRITE, policy).allowed, true);
  });
});

describe("decidePermission: workspace containment (both modes)", () => {
  for (const mode of [READ_ONLY, WORKSPACE_WRITE]) {
    it(`refuses an absolute write outside the workspace (${mode})`, () => {
      const result = decidePermission({ kind: "write", fileName: outsideFile }, mode, policy);
      assert.equal(result.allowed, false);
      assert.equal(result.decision.kind, "reject");
      assert.match(result.reason, /outside the workspace/);
      assert.equal(result.file, null);
    });

    it(`refuses a traversal write (${mode})`, () => {
      const result = decidePermission({ kind: "write", fileName: "../outside.txt" }, mode, policy);
      assert.equal(result.allowed, false);
      assert.match(result.reason, /outside the workspace/);
    });

    it(`refuses a read outside the workspace (${mode})`, () => {
      const result = decidePermission({ kind: "read", path: outsideFile }, mode, policy);
      assert.equal(result.allowed, false);
      assert.match(result.reason, /outside the workspace/);
      assert.match(result.reason, /Include the file in the prompt/);
    });

    it(`refuses a shell command that names a path outside the workspace (${mode})`, () => {
      const request = shell({
        fullCommandText: `cat ${outsideFile}`,
        commands: [{ identifier: "cat", readOnly: true }],
        possiblePaths: [outsideFile]
      });
      const result = decidePermission(request, mode, policy);
      assert.equal(result.allowed, false);
      assert.match(result.reason, /outside the workspace/);
      assert.ok(result.reason.includes(outsideFile));
    });

    it(`refuses a shell command that reaches into the home directory (${mode})`, () => {
      const request = shell({
        fullCommandText: "cat ~/.ssh/id_rsa",
        commands: [{ identifier: "cat", readOnly: true }],
        possiblePaths: ["~/.ssh/id_rsa"]
      });
      assert.equal(decidePermission(request, mode, policy).allowed, false);
    });

    it(`fails closed on a write with no usable fileName (${mode})`, () => {
      for (const fileName of [undefined, "", "a\0b"]) {
        const result = decidePermission({ kind: "write", fileName }, mode, policy);
        assert.equal(result.allowed, false, `expected ${JSON.stringify(fileName)} to be refused`);
        assert.match(result.reason, /invalid/);
      }
    });

    it(`fails closed on a read with no usable path (${mode})`, () => {
      const result = decidePermission({ kind: "read" }, mode, policy);
      assert.equal(result.allowed, false);
      assert.match(result.reason, /invalid/);
    });
  }

  it("resolves relative paths against the job cwd inside a larger workspace", () => {
    const nested = { workspaceRoot: ws, cwd: path.join(ws, "src") };
    assert.equal(decidePermission({ kind: "write", fileName: "../README.md" }, WORKSPACE_WRITE, nested).file, "README.md");
    assert.equal(decidePermission({ kind: "write", fileName: "../../outside.txt" }, WORKSPACE_WRITE, nested).allowed, false);
  });

  it("defaults the workspace to the process cwd when no policy is given", () => {
    const outsideCwd = path.resolve(process.cwd(), "..", "definitely-outside.txt");
    assert.equal(decidePermission({ kind: "write", fileName: outsideCwd }, WORKSPACE_WRITE).allowed, false);
    assert.equal(decidePermission({ kind: "write", fileName: "package.json" }, WORKSPACE_WRITE).allowed, true);
  });
});

describe("decidePermission: refused in every mode", () => {
  it("still refuses the SDK's sandbox-bypass flag if a runtime ever sets it", () => {
    // The SDK only sets this when a host enables `sandbox.allowBypass`, which
    // this plugin never does. Containment above is the real mechanism; this
    // is defense in depth.
    const request = shell({ requestSandboxBypass: true, requestSandboxBypassReason: "need root" });
    for (const mode of [READ_ONLY, WORKSPACE_WRITE]) {
      const result = decidePermission(request, mode, policy);
      assert.equal(result.allowed, false, `expected denial in ${mode}`);
      assert.match(result.reason, /Sandbox bypass/);
    }
  });

  it("refuses memory writes, which would outlive the job unseen", () => {
    for (const mode of [READ_ONLY, WORKSPACE_WRITE]) {
      assert.equal(decidePermission({ kind: "memory", fact: "x" }, mode, policy).allowed, false);
    }
  });

  it("fails closed on an unrecognized request kind", () => {
    const result = decidePermission({ kind: "some-future-capability" }, WORKSPACE_WRITE, policy);
    assert.equal(result.allowed, false);
    assert.match(result.reason, /unrecognized/);
  });

  it("fails closed on a malformed request", () => {
    assert.equal(decidePermission(undefined, WORKSPACE_WRITE, policy).allowed, false);
  });
});

describe("createPermissionHandler", () => {
  it("returns the SDK decision and reports it to the observer", () => {
    const seen = [];
    const handler = createPermissionHandler(READ_ONLY, (entry) => seen.push(entry), { workspaceRoot: ws });

    const decision = handler({ kind: "write", fileName: "src/index.js" });

    assert.equal(decision.kind, "reject");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].allowed, false);
    assert.equal(seen[0].kind, "write");
    assert.equal(seen[0].mode, READ_ONLY);
    assert.equal(seen[0].file, null);
    assert.match(seen[0].request, /src\/index\.js/);
  });

  it("reports the workspace-relative path of an allowed write", () => {
    const seen = [];
    const handler = createPermissionHandler(WORKSPACE_WRITE, (entry) => seen.push(entry), { workspaceRoot: ws });

    const decision = handler({ kind: "write", fileName: path.join(ws, "src", "b.js") });

    assert.equal(decision.kind, "approve-once");
    assert.equal(seen[0].allowed, true);
    assert.equal(seen[0].file, "src/b.js");
  });

  it("refuses a write outside the workspace even with --write", () => {
    const seen = [];
    const handler = createPermissionHandler(WORKSPACE_WRITE, (entry) => seen.push(entry), { workspaceRoot: ws });

    const decision = handler({ kind: "write", fileName: outsideFile });

    assert.equal(decision.kind, "reject");
    assert.match(decision.feedback, /outside the workspace/);
    assert.equal(seen[0].allowed, false);
  });

  it("works without an observer or scope", () => {
    const handler = createPermissionHandler(WORKSPACE_WRITE);
    assert.equal(handler({ kind: "read", path: "package.json" }).kind, "approve-once");
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
