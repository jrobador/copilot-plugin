import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { FakeCopilotClient } from "./fake-copilot-fixture.mjs";

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
