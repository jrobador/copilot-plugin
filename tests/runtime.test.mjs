import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { FakeCopilotClient } from "./fake-copilot-fixture.mjs";
import { buildPersistentTaskSessionId, parseStructuredOutput } from "../lib/copilot-client.mjs";

// The session id becomes a directory name under ~/.copilot/session-state/,
// so it has to be a slug. These assertions previously expected the
// human-readable "Copilot Plugin Task ..." string, which is what Codex calls
// a thread *name* -- a different concept that survived the port.
describe("runtime: buildPersistentTaskSessionId", () => {
  it("returns a slug carrying the task prefix", () => {
    const id = buildPersistentTaskSessionId("Fix the authentication bug");
    assert.ok(id.startsWith("copilot-plugin-task"));
    assert.ok(id.includes("fix-the-authentication-bug"));
  });

  it("is safe to use as a directory name", () => {
    const id = buildPersistentTaskSessionId("Fix C:\\path/with spaces & symbols!");
    assert.match(id, /^[a-z0-9-]+$/);
  });

  it("handles empty prompt", () => {
    const id = buildPersistentTaskSessionId("");
    assert.match(id, /^copilot-plugin-task-[a-z0-9]+$/);
  });

  it("shortens long prompts", () => {
    const longPrompt = "A".repeat(100);
    const id = buildPersistentTaskSessionId(longPrompt);
    assert.ok(id.length < 100);
  });

  // Audit M6 / task P1-6. The id used to be a pure function of the first 56
  // characters of the prompt, so two runs of the same prompt (every stop-gate
  // review, every "continue") asked the CLI to create a session with an id
  // that already existed.
  it("is unique across calls with the same prompt", () => {
      const first = buildPersistentTaskSessionId("Fix the authentication bug");
      const second = buildPersistentTaskSessionId("Fix the authentication bug");
      assert.notEqual(first, second);
      assert.match(second, /^[a-z0-9-]+$/);
      assert.ok(second.startsWith("copilot-plugin-task-fix-the-authentication-bug-"));
  });
});

describe("runtime: parseStructuredOutput", () => {
  it("parses valid JSON", () => {
    const result = parseStructuredOutput('{"verdict":"pass","summary":"All good"}');
    assert.equal(result.parsed.verdict, "pass");
    assert.equal(result.parseError, null);
  });

  it("handles invalid JSON", () => {
    const result = parseStructuredOutput("not json");
    assert.equal(result.parsed, null);
    assert.ok(result.parseError);
  });

  it("handles empty output", () => {
    const result = parseStructuredOutput("");
    assert.equal(result.parsed, null);
    assert.ok(result.parseError);
  });

  // Models wrap JSON in fences and prose often enough that a bare JSON.parse
  // rejects output that is otherwise exactly what was asked for.
  it("unwraps a fenced json block", () => {
    const raw = '```json\n{"verdict":"approve","summary":"Fine"}\n```';
    const result = parseStructuredOutput(raw);
    assert.equal(result.parsed.verdict, "approve");
    assert.equal(result.parseError, null);
  });

  it("unwraps an unlabelled fenced block", () => {
    const result = parseStructuredOutput('```\n{"verdict":"approve"}\n```');
    assert.equal(result.parsed.verdict, "approve");
  });

  it("recovers JSON wrapped in prose", () => {
    const raw = 'Here is the review:\n{"verdict":"needs-attention","findings":[]}\nHope that helps.';
    const result = parseStructuredOutput(raw);
    assert.equal(result.parsed.verdict, "needs-attention");
  });

  it("keeps the raw output when nothing parses", () => {
    const result = parseStructuredOutput("no json here at all");
    assert.equal(result.parsed, null);
    assert.equal(result.rawOutput, "no json here at all");
  });
});

describe("runtime: FakeCopilotClient end-to-end flow", () => {
  it("full task flow: start -> session -> prompt -> response", async () => {
    const client = new FakeCopilotClient();
    client.setSessionConfig({
      _cannedResponse: { data: { content: "Task completed successfully." } }
    });

    await client.start();
    const session = await client.createSession({
      model: "gpt-5.4",
      sessionId: "task-session-1"
    });

    const response = await session.sendAndWait({ prompt: "Fix the bug" });
    assert.equal(response.data.content, "Task completed successfully.");

    await client.stop();
    assert.equal(client.stopped, true);
  });

  it("full review flow with streaming events", async () => {
    const client = new FakeCopilotClient();
    const collectedEvents = [];

    client.setSessionConfig({
      _cannedEvents: [
        { type: { value: "tool.execution_start" }, data: { toolName: "read_file" } },
        { type: { value: "assistant.message_delta" }, data: { deltaContent: "Review: " } },
        { type: { value: "session.idle" }, data: {} }
      ],
      _cannedResponse: { data: { content: '{"verdict":"pass","summary":"LGTM"}' } }
    });

    await client.start();
    const session = await client.createSession({ model: "gpt-5.4" });
    session.on((event) => collectedEvents.push(event.type.value));

    const response = await session.sendAndWait({ prompt: "Review this diff" });
    const parsed = parseStructuredOutput(response.data.content);

    assert.equal(parsed.parsed.verdict, "pass");
    assert.deepEqual(collectedEvents, ["tool.execution_start", "assistant.message_delta", "session.idle"]);
  });
});
