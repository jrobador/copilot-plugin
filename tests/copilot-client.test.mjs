import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { FakeCopilotClient, FakeCopilotSession } from "./fake-copilot-fixture.mjs";
import {
  DECISION_SINK,
  getCopilotAvailability,
  runPrompt
} from "../plugins/copilot/scripts/lib/copilot-client.mjs";

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
      request: "write: src/a.js"
    });
    target[DECISION_SINK].current({
      allowed: true,
      kind: "write",
      reason: "write mode",
      mode: "workspace-write",
      request: "write: src/b.js"
    });
    const result = await promise;

    assert.equal(result.denials.length, 1);
    assert.equal(result.denials[0].kind, "write");
    assert.deepEqual(result.touchedFiles, ["src/b.js"]);
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
    const result = getCopilotAvailability(process.cwd());
    assert.equal(result.available, true);
    assert.ok(["path", "bundled"].includes(result.source));
  });
});
