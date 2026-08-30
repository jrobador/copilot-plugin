import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  createPermissionHandler,
  decidePermission,
  describeRequest,
  isProtectedPath,
  makeSentinelEscalation,
  normalizeMode,
  PROTECTED_PATHS,
  READ_ONLY,
  RUN_COMMAND_TOOL_NAME,
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
    assert.equal(describeRequest({ kind: "custom-tool", toolName: "run_command" }), "custom-tool: run_command");
    assert.equal(describeRequest(undefined), "unknown");
  });
});

describe("isProtectedPath", () => {
  it("matches git metadata, hooks, workflows and editor tasks", () => {
    for (const rel of [".git", ".git/config", ".git/hooks/pre-commit", ".github/workflows/ci.yml", ".husky/pre-commit", ".vscode/tasks.json"]) {
      assert.equal(isProtectedPath(rel).protected, true, rel);
      assert.ok(PROTECTED_PATHS.includes(isProtectedPath(rel).pattern));
    }
  });

  it("leaves ordinary dotfiles alone", () => {
    for (const rel of ["", ".gitignore", ".gitattributes", ".github/CODEOWNERS", ".vscode/settings.json", "src/.git-keep", ".husky-notes"]) {
      assert.equal(isProtectedPath(rel).protected, false, rel);
    }
    assert.equal(isProtectedPath(undefined).protected, false);
  });

  it("ignores case on Windows", { skip: process.platform !== "win32" }, () => {
    assert.equal(isProtectedPath(".GIT/config").protected, true);
    assert.equal(isProtectedPath(".Github/Workflows/ci.yml").protected, true);
  });
});

describe("decidePermission: protected paths", () => {
  for (const mode of [READ_ONLY, WORKSPACE_WRITE]) {
    it(`refuses writes to protected paths (${mode})`, () => {
      for (const fileName of [".git/config", ".github/workflows/ci.yml", ".husky/pre-commit", ".vscode/tasks.json", path.join(ws, ".git", "hooks", "pre-commit")]) {
        const result = decidePermission({ kind: "write", fileName }, mode, policy);
        assert.equal(result.allowed, false, fileName);
        assert.match(result.reason, /protected path/);
      }
    });
  }

  it("still allows ordinary dotfiles in write mode and reads of git metadata", () => {
    for (const fileName of [".gitignore", ".github/CODEOWNERS", ".vscode/settings.json"]) {
      assert.equal(decidePermission({ kind: "write", fileName }, WORKSPACE_WRITE, policy).allowed, true, fileName);
    }
    assert.equal(decidePermission({ kind: "read", path: ".git/HEAD" }, READ_ONLY, policy).allowed, true);
  });
});

describe("decidePermission: hardlinks", () => {
  it("refuses writing a file that is hardlinked elsewhere", (t) => {
    const original = path.join(ws, "linked.txt");
    const alias = path.join(ws, "alias.txt");
    fs.writeFileSync(original, "x");
    try {
      fs.linkSync(original, alias);
    } catch (error) {
      t.skip(`hardlinks not supported here (${error.code})`);
      return;
    }
    const result = decidePermission({ kind: "write", fileName: "linked.txt" }, WORKSPACE_WRITE, policy);
    assert.equal(result.allowed, false);
    assert.match(result.reason, /hardlinked/);
    assert.equal(decidePermission({ kind: "write", fileName: "alias.txt" }, WORKSPACE_WRITE, policy).allowed, false);
  });

  it("allows files with a single link and files that do not exist yet", () => {
    fs.writeFileSync(path.join(ws, "single.txt"), "x");
    assert.equal(decidePermission({ kind: "write", fileName: "single.txt" }, WORKSPACE_WRITE, policy).allowed, true);
    assert.equal(decidePermission({ kind: "write", fileName: "brand-new.txt" }, WORKSPACE_WRITE, policy).allowed, true);
  });
});

describe("decidePermission: custom tools", () => {
  it("allows only run_command", () => {
    for (const mode of [READ_ONLY, WORKSPACE_WRITE]) {
      assert.equal(decidePermission({ kind: "custom-tool", toolName: RUN_COMMAND_TOOL_NAME }, mode, policy).allowed, true);
      const other = decidePermission({ kind: "custom-tool", toolName: "other" }, mode, policy);
      assert.equal(other.allowed, false);
      assert.match(other.reason, /not registered/);
    }
  });
});

describe("decidePermission: read escalation", () => {
  const escalate = makeSentinelEscalation("ESCALATE_ME.txt");

  it("escalates a flagged read: denied at the wire but marked for the owner", () => {
    const result = decidePermission(
      { kind: "read", path: "ESCALATE_ME.txt" },
      READ_ONLY,
      { workspaceRoot: ws, escalateReads: escalate }
    );
    assert.equal(result.escalate, true);
    assert.equal(result.allowed, false);
    assert.equal(result.decision.kind, "reject"); // wire-level deny
    assert.equal(result.file, "ESCALATE_ME.txt");
    assert.match(result.reason, /approv/i);
  });

  it("leaves ordinary reads untouched when a predicate is present", () => {
    const result = decidePermission(
      { kind: "read", path: "src/index.js" },
      READ_ONLY,
      { workspaceRoot: ws, escalateReads: escalate }
    );
    assert.equal(result.allowed, true);
    assert.notEqual(result.escalate, true);
  });

  it("allows a flagged read once the owner approved that path", () => {
    const result = decidePermission(
      { kind: "read", path: "ESCALATE_ME.txt" },
      READ_ONLY,
      { workspaceRoot: ws, escalateReads: escalate, approvedReads: new Set(["ESCALATE_ME.txt"]) }
    );
    assert.equal(result.allowed, true);
    assert.notEqual(result.escalate, true);
  });

  it("does not escalate without a predicate (default behaviour unchanged)", () => {
    const result = decidePermission({ kind: "read", path: "ESCALATE_ME.txt" }, READ_ONLY, { workspaceRoot: ws });
    assert.equal(result.allowed, true);
    assert.notEqual(result.escalate, true);
  });

  it("the handler forwards the escalate flag to the observer", () => {
    let entry = null;
    const handler = createPermissionHandler(READ_ONLY, (e) => (entry = e), {
      workspaceRoot: ws,
      escalateReads: escalate
    });
    const decision = handler({ kind: "read", path: "ESCALATE_ME.txt" });
    assert.equal(decision.kind, "reject");
    assert.equal(entry.escalate, true);
    assert.equal(entry.file, "ESCALATE_ME.txt");
  });
});

// Audit L8 / task P1-4. `.claude/` holds settings.json, whose hooks run on the
// user's behalf in the next Claude Code session: same class as .git/hooks.
describe("decidePermission: .claude/ is a protected path", () => {
  it(
    "refuses writes under .claude/ in both modes",
    { todo: "P1-4: add .claude/** to PROTECTED_PATHS" },
    () => {
      for (const mode of [READ_ONLY, WORKSPACE_WRITE]) {
        for (const fileName of [".claude/settings.json", ".claude/settings.local.json", ".claude/hooks/x.sh"]) {
          const result = decidePermission({ kind: "write", fileName }, mode, policy);
          assert.equal(result.allowed, false, `${mode} ${fileName}`);
          assert.match(result.reason, /protected path/);
        }
      }
      assert.equal(isProtectedPath(".claude/settings.json").protected, true);
    }
  );
});

describe("makeSentinelEscalation", () => {
  it("matches the sentinel basename anywhere in the tree, case-insensitively on Windows", () => {
    const escalate = makeSentinelEscalation("ESCALATE_ME.txt");
    assert.equal(escalate("ESCALATE_ME.txt"), true);
    assert.equal(escalate("nested/dir/ESCALATE_ME.txt"), true);
    assert.equal(escalate("src/index.js"), false);
    assert.equal(escalate(""), false);
  });
});
