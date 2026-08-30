import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ensureClient,
  getCopilotAvailability,
  getCopilotLoginStatus,
  listModels,
  resumeSession,
  createSession,
  runPrompt,
  SDK_MODULE_ENV,
  shutdownClient
} from "../plugins/copilot/scripts/lib/copilot-client.mjs";
import { FakeCopilotClient } from "./fake-copilot-fixture.mjs";
import { cleanupDir, createTempWorkspace } from "./helpers.mjs";

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fake-copilot-fixture.mjs");

// The companion imports @github/copilot-sdk by name, which needs a login to do
// anything. COPILOT_COMPANION_SDK_MODULE swaps in the fixture so the real
// session/prompt/permission plumbing can be exercised in tests.
describe("SDK injection through COPILOT_COMPANION_SDK_MODULE", () => {
  let previous;
  let ws;

  before(() => {
    previous = process.env[SDK_MODULE_ENV];
    process.env[SDK_MODULE_ENV] = FIXTURE;
    ws = createTempWorkspace();
  });

  after(async () => {
    await shutdownClient();
    if (previous === undefined) delete process.env[SDK_MODULE_ENV];
    else process.env[SDK_MODULE_ENV] = previous;
    cleanupDir(ws);
  });

  it("ensureClient instantiates the fixture's CopilotClient", async () => {
    const client = await ensureClient(ws);
    assert.ok(client instanceof FakeCopilotClient);
    assert.equal(client.started, true);
    assert.equal(client.options.workingDirectory, ws);
  });

  it("reports the fake runtime as available", () => {
    const availability = getCopilotAvailability(ws);
    assert.equal(availability.available, true);
    assert.equal(availability.source, "override");
  });

  it("answers auth and model queries from the fake", async () => {
    const auth = await getCopilotLoginStatus(ws);
    assert.equal(auth.available, true);
    assert.equal(auth.loggedIn, true);
    assert.equal(auth.login, "fake-user");

    const models = await listModels(ws);
    assert.ok(models.some((model) => model.id === "gpt-5.4"));
  });

  it("creates a session with the plugin's permission handler and run_command tool", async () => {
    const session = await createSession({ cwd: ws, workspaceRoot: ws, sessionId: "inj-1" });
    assert.equal(session.sessionId, "inj-1");
    assert.equal(typeof session.config.onPermissionRequest, "function");
    assert.ok(session.config.tools.some((tool) => tool.name === "run_command"));
    assert.ok(session.config.excludedTools.includes("bash"));

    const result = await runPrompt(session, "hello");
    assert.equal(result.content, "Mock response");
    assert.equal(result.sessionId, "inj-1");
  });

  it("resumes a session the fake knows and falls back for one it does not", async () => {
    const known = await resumeSession("inj-1", { cwd: ws, workspaceRoot: ws });
    assert.equal(known.resumed, true);
    assert.equal(known.session.sessionId, "inj-1");

    const unknown = await resumeSession("never-created", { cwd: ws, workspaceRoot: ws });
    assert.equal(unknown.resumed, false);
    assert.ok(unknown.session, "a fresh session is started when fallback is allowed");

    const strict = await resumeSession("never-created-2", { cwd: ws, workspaceRoot: ws, allowFreshFallback: false });
    assert.equal(strict.resumed, false);
    assert.equal(strict.session, null);
  });

  it("fails closed with SDK_MISSING when the override path does not load", async () => {
    process.env[SDK_MODULE_ENV] = path.join(ws, "does-not-exist.mjs");
    const other = createTempWorkspace();
    try {
      await assert.rejects(() => ensureClient(other), (error) => error.code === "SDK_MISSING" && /could not be loaded/.test(error.message));
    } finally {
      process.env[SDK_MODULE_ENV] = FIXTURE;
      cleanupDir(other);
    }
  });
});
