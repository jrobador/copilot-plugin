import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";
import path from "node:path";

import { FakeCopilotClient, FakeCopilotSession } from "./fake-copilot-fixture.mjs";
import {
  buildSessionConfig,
  buildTaskPayload,
  DECISION_SINK,
  getCopilotAvailability,
  READ_ONLY,
  runPrompt,
  WORKSPACE_WRITE
} from "../lib/copilot-client.mjs";
import { cleanupDir, createTempWorkspace } from "./helpers.mjs";

// We test the module's exported functions by mocking the SDK.
// Since the module uses a real import, we test the logic patterns here.

describe("copilot-client patterns", () => {
  let client;

  beforeEach(() => {
    client = new FakeCopilotClient();
  });

  it("client lifecycle: start and stop", async () => {
    await client.start();
    assert.equal(client.started, true);
    await client.stop();
    assert.equal(client.stopped, true);
  });

  it("creates session with config", async () => {
    await client.start();
    const session = await client.createSession({
      model: "gpt-5.4",
      streaming: true,
      sessionId: "test-session"
    });
    assert.equal(session.config.model, "gpt-5.4");
    assert.equal(session.config.sessionId, "test-session");
  });

  it("sendAndWait returns canned response", async () => {
    await client.start();
    client.setSessionConfig({ _cannedResponse: { data: { content: "Hello from Copilot" } } });
    const session = await client.createSession({ model: "gpt-5.4" });
    const response = await session.sendAndWait({ prompt: "test" });
    assert.equal(response.data.content, "Hello from Copilot");
  });

  it("session abort records call", async () => {
    await client.start();
    const session = await client.createSession({});
    await session.abort();
    assert.equal(session.aborted, true);
  });

  it("session emits events to listeners", async () => {
    await client.start();
    const events = [];
    client.setSessionConfig({
      _cannedEvents: [
        { type: { value: "assistant.message_delta" }, data: { deltaContent: "chunk1" } },
        { type: { value: "session.idle" }, data: {} }
      ],
      _cannedResponse: { data: { content: "full response" } }
    });
    const session = await client.createSession({});
    session.on((event) => events.push(event.type.value));
    await session.sendAndWait({ prompt: "test" });
    assert.deepEqual(events, ["assistant.message_delta", "session.idle"]);
  });
});

describe("runPrompt", () => {
  const session = (events, response) =>
    new FakeCopilotSession({
      _cannedEvents: events,
      _cannedResponse: response ?? { data: { content: "done" } }
    });

  it("names the tool on completion", async () => {
    // tool.execution_complete carries only a toolCallId, so the name has to be
    // remembered from the start event. Without that the progress log read
    // "Tool undefined completed" for every call.
    const progress = [];
    const target = session([
      { type: "tool.execution_start", data: { toolName: "grep", toolCallId: "c1" } },
      { type: "tool.execution_complete", data: { toolCallId: "c1", success: true } }
    ]);

    const result = await runPrompt(target, "go", { onProgress: (p) => progress.push(p.message) });

    assert.deepEqual(result.toolCalls, ["grep"]);
    assert.ok(progress.includes("Tool grep completed."));
    assert.ok(!progress.some((message) => message.includes("undefined")));
  });

  it("reports a failed tool as failed", async () => {
    const progress = [];
    const target = session([
      { type: "tool.execution_start", data: { toolName: "powershell", toolCallId: "c9" } },
      { type: "tool.execution_complete", data: { toolCallId: "c9", success: false } }
    ]);

    await runPrompt(target, "go", { onProgress: (p) => progress.push(p.message) });

    assert.ok(progress.includes("Tool powershell failed."));
  });

  it("removes its listener when the turn ends", async () => {
    const target = session([]);
    await runPrompt(target, "one");
    await runPrompt(target, "two");
    // A leaked listener per turn would double-count every later event.
    assert.equal(target.listeners.length, 0);
  });

  it("falls back to streamed chunks when the response carries no content", async () => {
    const target = session(
      [
        { type: "assistant.message_delta", data: { deltaContent: "par" } },
        { type: "assistant.message_delta", data: { deltaContent: "tial" } }
      ],
      { data: {} }
    );

    const result = await runPrompt(target, "go");
    assert.equal(result.content, "partial");
  });

  it("records denied permissions and files written", async () => {
    const target = session([]);
    target[DECISION_SINK] = { current: null };

    const promise = runPrompt(target, "go");
    // The handler is bound at session creation and fires mid-turn.
    target[DECISION_SINK].current({
      allowed: false,
      kind: "write",
      reason: "read-only",
      mode: "read-only",
      request: "write: src/a.js",
      file: "src/a.js"
    });
    target[DECISION_SINK].current({
      allowed: true,
      kind: "write",
      reason: "write mode",
      mode: "workspace-write",
      request: "write: src/b.js",
      file: "src/b.js"
    });
    const result = await promise;

    assert.equal(result.denials.length, 1);
    assert.equal(result.denials[0].kind, "write");
    assert.deepEqual(result.touchedFiles, ["src/b.js"]);
  });

  it("captures an escalated request as pendingApproval, not a denial", async () => {
    const target = session([]);
    target[DECISION_SINK] = { current: null };

    const promise = runPrompt(target, "go");
    target[DECISION_SINK].current({
      escalate: true,
      allowed: false,
      kind: "read",
      reason: "needs owner approval",
      mode: "read-only",
      request: "read: ESCALATE_ME.txt",
      file: "ESCALATE_ME.txt"
    });
    const result = await promise;

    assert.equal(result.escalated, true);
    assert.equal(result.pendingApproval.kind, "read");
    assert.equal(result.pendingApproval.file, "ESCALATE_ME.txt");
    assert.match(result.pendingApproval.request, /ESCALATE_ME/);
    // An escalation is not counted as an ordinary denial.
    assert.equal(result.denials.length, 0);
  });

  it("only keeps the first escalation when several fire", async () => {
    const target = session([]);
    target[DECISION_SINK] = { current: null };
    const promise = runPrompt(target, "go");
    target[DECISION_SINK].current({ escalate: true, allowed: false, kind: "read", reason: "r1", mode: "read-only", request: "read: a", file: "a" });
    target[DECISION_SINK].current({ escalate: true, allowed: false, kind: "read", reason: "r2", mode: "read-only", request: "read: b", file: "b" });
    const result = await promise;
    assert.equal(result.pendingApproval.file, "a");
  });

  it("restores the previous decision sink afterwards", async () => {
    const target = session([]);
    target[DECISION_SINK] = { current: null };
    await runPrompt(target, "go");
    assert.equal(target[DECISION_SINK].current, null);
  });

  it("passes attachments and agent mode through as message options", async () => {
    const target = session([]);
    const attachments = [{ type: "directory", path: "/repo" }];

    await runPrompt(target, "review", { attachments, agentMode: "plan" });

    assert.deepEqual(target.messages[0].attachments, attachments);
    assert.equal(target.messages[0].agentMode, "plan");
  });

  it("sends a bare prompt when there is nothing to attach", async () => {
    const target = session([]);
    await runPrompt(target, "hello");
    assert.equal(target.messages[0], "hello");
  });
});

describe("getCopilotAvailability", () => {
  it("finds the CLI bundled with the SDK when it is not on PATH", () => {
    // The SDK depends on @github/copilot, so a global install is not required.
    // CI installs with --no-optional, so the bundled package may be absent;
    // what matters is that the answer is consistent either way.
    const result = getCopilotAvailability(process.cwd());
    assert.equal(typeof result.available, "boolean");
    if (result.available) {
      assert.ok(["path", "bundled"].includes(result.source));
    } else {
      // The detail explains why, and varies: "not found" when nothing resolves,
      // or the runner's own error when a stale shim is on PATH.
      assert.equal(result.source, null);
    }
    assert.ok(result.detail);
  });
});

describe("buildSessionConfig", () => {
  let parent;
  let ws;
  before(() => {
    parent = createTempWorkspace();
    ws = path.join(parent, "ws");
    fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  });
  after(() => cleanupDir(parent));

  it("binds the permission handler to the workspace root", () => {
    const seen = [];
    const sink = { current: (entry) => seen.push(entry) };
    const config = buildSessionConfig({ cwd: ws, workspaceRoot: ws }, WORKSPACE_WRITE, sink);

    const outside = config.onPermissionRequest({ kind: "write", fileName: path.join(parent, "escape.txt") });
    const inside = config.onPermissionRequest({ kind: "write", fileName: path.join(ws, "src", "b.js") });

    assert.equal(outside.kind, "reject");
    assert.match(outside.feedback, /outside the workspace/);
    assert.equal(inside.kind, "approve-once");
    assert.deepEqual(
      seen.map((entry) => [entry.allowed, entry.file]),
      [
        [false, null],
        [true, "src/b.js"]
      ]
    );
  });

  it("falls back to the cwd as the root when none is given", () => {
    const sink = { current: null };
    const config = buildSessionConfig({ cwd: ws }, WORKSPACE_WRITE, sink);
    assert.equal(config.onPermissionRequest({ kind: "write", fileName: "src/c.js" }).kind, "approve-once");
    assert.equal(config.onPermissionRequest({ kind: "write", fileName: "../escape.txt" }).kind, "reject");
  });

  it("judges relative paths from a sub-directory cwd against the git root", () => {
    const sink = { current: null };
    const config = buildSessionConfig({ cwd: path.join(ws, "src"), workspaceRoot: ws }, WORKSPACE_WRITE, sink);
    assert.equal(config.onPermissionRequest({ kind: "write", fileName: "../README.md" }).kind, "approve-once");
    assert.equal(config.onPermissionRequest({ kind: "write", fileName: "../../escape.txt" }).kind, "reject");
  });

  it("reports touched files through runPrompt end to end", async () => {
    const target = new FakeCopilotSession({ _cannedEvents: [], _cannedResponse: { data: { content: "ok" } } });
    const sink = { current: null };
    const config = buildSessionConfig({ cwd: ws, workspaceRoot: ws }, WORKSPACE_WRITE, sink);
    target[DECISION_SINK] = sink;

    const promise = runPrompt(target, "go");
    config.onPermissionRequest({ kind: "write", fileName: path.join(ws, "src", "b.js") });
    config.onPermissionRequest({ kind: "write", fileName: path.join(parent, "escape.txt") });
    const result = await promise;

    assert.deepEqual(result.touchedFiles, ["src/b.js"]);
    assert.equal(result.denials.length, 1);
    assert.match(result.denials[0].reason, /outside the workspace/);
  });
});

describe("buildSessionConfig: run_command", () => {
  let parent;
  let ws;
  before(() => {
    parent = createTempWorkspace();
    ws = path.join(parent, "ws");
    fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  });
  after(() => cleanupDir(parent));

  const shellTools = [
    "bash",
    "read_bash",
    "write_bash",
    "stop_bash",
    "list_bash",
    "powershell",
    "read_powershell",
    "write_powershell",
    "stop_powershell",
    "list_powershell"
  ];

  it("registers run_command and excludes the runtime's shell tools", () => {
    const config = buildSessionConfig({ cwd: ws, workspaceRoot: ws }, WORKSPACE_WRITE, { current: null });
    assert.equal(config.tools.length, 1);
    const tool = config.tools[0];
    assert.equal(tool.name, "run_command");
    assert.equal(tool.skipPermission, true);
    assert.equal(tool.defer, "never");
    assert.equal(tool.parameters.type, "object");
    assert.equal(typeof tool.handler, "function");
    assert.deepEqual([...config.excludedTools].sort(), [...shellTools].sort());
  });

  it("keeps the caller's exclusions alongside the shell tools", () => {
    const config = buildSessionConfig({ cwd: ws, excludedTools: ["fetch"] }, READ_ONLY, { current: null });
    assert.equal(config.excludedTools.length, 11);
    assert.ok(config.excludedTools.includes("fetch"));
    assert.ok(config.excludedTools.includes("bash"));
  });

  it("leaves the shell tools in place only with unsafeShell", () => {
    const config = buildSessionConfig({ cwd: ws, unsafeShell: true }, WORKSPACE_WRITE, { current: null });
    assert.equal(config.excludedTools, undefined);
    assert.equal(config.tools[0].name, "run_command");
  });

  it("threads extraPrograms into the tool", () => {
    const config = buildSessionConfig({ cwd: ws, extraPrograms: ["bun"] }, WORKSPACE_WRITE, { current: null });
    assert.match(config.tools[0].description, /Allowed programs: .*bun/);
  });

  it("routes command denials and successes into the running turn", async () => {
    // The fake turn must stay open while the (async) tool handler runs, or the
    // sink is restored before the command reports. sendAndWait awaits whatever
    // _cannedResponse is, so gate it on a promise we release afterwards.
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const target = new FakeCopilotSession({ _cannedEvents: [], _cannedResponse: gate });
    const sink = { current: null };
    const progress = [];
    const config = buildSessionConfig({ cwd: ws, workspaceRoot: ws }, WORKSPACE_WRITE, sink);
    target[DECISION_SINK] = sink;

    const promise = runPrompt(target, "go", { onProgress: (p) => progress.push(p) });
    const denied = await config.tools[0].handler({ program: "node", args: ["-e", "1"] });
    const ran = await config.tools[0].handler({ program: "node", args: ["--version"] });
    release({ data: { content: "ok" } });
    const result = await promise;

    assert.equal(denied.resultType, "denied");
    assert.equal(ran.resultType, "success");
    assert.equal(result.denials.length, 1);
    assert.equal(result.denials[0].kind, "command");
    assert.deepEqual(result.touchedFiles, []);
    const line = progress.find((p) => p.message.startsWith("Ran command: node --version"));
    assert.ok(line, "expected a progress line for the allowed command");
    assert.equal(line.logTitle, "Command (exit 0)");
  });
});

describe("buildTaskPayload", () => {
  it("carries touched files and denials from the turn", () => {
    const payload = buildTaskPayload(
      {
        content: "Done.",
        sessionId: "sess-2",
        reasoning: "thought",
        touchedFiles: ["src/a.js"],
        denials: [{ kind: "write", reason: "outside" }]
      },
      { sessionId: "sess-1", rawOutput: "Done." }
    );
    assert.deepEqual(payload, {
      status: 0,
      sessionId: "sess-2",
      rawOutput: "Done.",
      touchedFiles: ["src/a.js"],
      denials: [{ kind: "write", reason: "outside" }],
      unsafeShell: false,
      reasoningSummary: ["thought"]
    });
  });

  it("records an unfenced shell on the payload", () => {
    const payload = buildTaskPayload({ content: "x" }, { sessionId: "s", rawOutput: "x", unsafeShell: true });
    assert.equal(payload.unsafeShell, true);
  });

  it("falls back to empty lists and the caller's session id", () => {
    const payload = buildTaskPayload({ content: "" }, { sessionId: "sess-1", rawOutput: "" });
    assert.equal(payload.status, 1);
    assert.equal(payload.sessionId, "sess-1");
    assert.deepEqual(payload.touchedFiles, []);
    assert.deepEqual(payload.denials, []);
    assert.deepEqual(payload.reasoningSummary, []);
  });
});
