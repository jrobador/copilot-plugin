import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createTempWorkspace, cleanupDir } from "./helpers.mjs";
import { createServer } from "../bin/copilot-mcp.mjs";
import { ALLOW_WRITE_ENV, TOOLS } from "../lib/mcp/tools.mjs";
import { SDK_MODULE_ENV } from "../lib/copilot-client.mjs";

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fake-copilot-fixture.mjs");

/**
 * The MCP server spawns the real CLI, which talks to the fake SDK (via
 * COPILOT_PLUGIN_SDK_MODULE). So this exercises the whole path: MCP tool call
 * → CLI → runtime → fake Copilot, over an in-memory MCP transport.
 */
describe("MCP server", () => {
  let repo;
  let client;
  let server;
  const saved = {};

  async function connect() {
    server = createServer();
    client = new Client({ name: "test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  }

  before(async () => {
    repo = createTempWorkspace();
    execSync("git init", { cwd: repo });
    execSync("git config user.email test@test.com", { cwd: repo });
    execSync("git config user.name Test", { cwd: repo });
    fs.writeFileSync(path.join(repo, "f.txt"), "hello\n");
    execSync("git add . && git commit -m init", { cwd: repo });

    for (const key of ["CLAUDE_PLUGIN_DATA", SDK_MODULE_ENV, "COPILOT_FAKE_CONFIG", "COPILOT_PLUGIN_SESSION_ID"]) {
      saved[key] = process.env[key];
    }
    process.env.CLAUDE_PLUGIN_DATA = path.join(repo, ".plugin-data");
    process.env[SDK_MODULE_ENV] = FIXTURE;
    process.env.COPILOT_PLUGIN_SESSION_ID = "mcp-test-session";
    await connect();
  });

  after(async () => {
    await client?.close();
    await server?.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    cleanupDir(repo);
  });

  it("lists every tool with a name, description and input schema", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, TOOLS.map((t) => t.name).sort());
    assert.ok(names.includes("copilot_review"));
    assert.ok(names.includes("copilot_status"));
    assert.ok(names.includes("copilot_approve"));
    for (const tool of tools) {
      assert.ok(tool.description, `${tool.name} has no description`);
      assert.equal(tool.inputSchema.type, "object");
    }
  });

  it("copilot_status returns the status report for the repo", async () => {
    const res = await client.callTool({ name: "copilot_status", arguments: { path: repo } });
    assert.notEqual(res.isError, true, JSON.stringify(res.content));
    const text = res.content.map((c) => c.text).join("\n");
    assert.match(text, /# Copilot Status/);
    assert.match(text, /No jobs recorded yet/);
  });

  it("copilot_review runs a review through the CLI and fake SDK", async () => {
    fs.writeFileSync(path.join(repo, "change.txt"), "a new line to review\n");
    process.env.COPILOT_FAKE_CONFIG = JSON.stringify({
      session: { response: '{"verdict":"approve","summary":"Looks fine.","findings":[],"next_steps":[]}' }
    });
    try {
      const res = await client.callTool({ name: "copilot_review", arguments: { path: repo } });
      assert.notEqual(res.isError, true, JSON.stringify(res.content));
      const text = res.content.map((c) => c.text).join("\n");
      assert.match(text, /Verdict: approve/);
    } finally {
      delete process.env.COPILOT_FAKE_CONFIG;
      fs.unlinkSync(path.join(repo, "change.txt"));
    }
  });

  it("reports an unknown tool as an error result, not a throw", async () => {
    const res = await client.callTool({ name: "copilot_nope", arguments: {} });
    assert.equal(res.isError, true);
    assert.match(res.content.map((c) => c.text).join("\n"), /Unknown tool/);
  });

  it("surfaces a CLI failure as isError with the message", async () => {
    const res = await client.callTool({ name: "copilot_result", arguments: { path: repo, job_id: "does-not-exist" } });
    assert.equal(res.isError, true);
    const text = res.content.map((c) => c.text).join("\n");
    assert.match(text, /No .*job|not found/i);
  });
  // Claude Code's rescue command may not add these flags unless the user typed
  // them. MCP has no user-typed channel, so the model must not reach them.
  it("keeps the escalation flags out of the rescue tool's reach", () => {
    const rescue = TOOLS.find((tool) => tool.name === "copilot_rescue");
    const properties = rescue.inputSchema.properties;
    assert.equal(properties.unsafe_shell, undefined);
    assert.equal(properties.allow_wide_root, undefined);
    const argv = rescue.toArgv({ prompt: "x", unsafe_shell: true, allow_wide_root: true, write: true });
    assert.ok(!argv.includes("--unsafe-shell"));
    assert.ok(!argv.includes("--allow-wide-root"));
  });

  it("refuses a write rescue unless the owner enabled it in the server environment", async () => {
    const res = await client.callTool({ name: "copilot_rescue", arguments: { path: repo, prompt: "fix it", write: true } });
    assert.equal(res.isError, true);
    assert.match(res.content.map((c) => c.text).join("\n"), new RegExp(ALLOW_WRITE_ENV));

    const rescue = TOOLS.find((tool) => tool.name === "copilot_rescue");
    assert.equal(rescue.guard({ write: true }, { [ALLOW_WRITE_ENV]: "1" }), null);
    assert.equal(rescue.guard({ write: false }, {}), null);
  });
});
