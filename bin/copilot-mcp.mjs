#!/usr/bin/env node
/**
 * MCP stdio server for the Copilot plugin.
 *
 * Exposes the plugin's commands as MCP tools so any MCP client (Cursor,
 * Windsurf, VS Code, …) can drive it. Each tool spawns the CLI
 * (bin/copilot-plugin.mjs) and returns its output verbatim, so the whole
 * runtime — argument policy, permissions, background workers, the approval
 * flow — is reused unchanged. No network, no hosting: the client spawns this
 * process on demand and talks to it over stdin/stdout.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { ROOT_DIR } from "../lib/plugin-root.mjs";
import { findTool, toolDefinitions } from "../lib/mcp/tools.mjs";

const CLI = path.join(ROOT_DIR, "bin", "copilot-plugin.mjs");
const SERVER_INFO = { name: "copilot-plugin", version: "0.2.0" };
// A rescue or review can take a while; the tool call blocks until the CLI exits.
const CLI_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

/**
 * Run the CLI once and collect its output. Never throws: a failure comes back
 * as `{ ok:false, text }` so the tool result carries it to the model.
 *
 * @param {string[]} argv
 * @param {string} cwd
 * @param {{spawnImpl?: typeof spawn}} [seams]
 */
function runCli(argv, cwd, seams = {}) {
  const spawnImpl = seams.spawnImpl ?? spawn;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(process.execPath, [CLI, ...argv], {
        cwd,
        env: process.env,
        windowsHide: true
      });
    } catch (error) {
      resolve({ ok: false, text: `Failed to start the Copilot CLI: ${error.message}` });
      return;
    }

    const out = [];
    const err = [];
    let size = 0;
    let settled = false;
    const push = (buf, sink) => {
      size += buf.length;
      if (size <= MAX_OUTPUT_BYTES) sink.push(buf);
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      finish({ ok: false, text: `The Copilot CLI timed out after ${Math.round(CLI_TIMEOUT_MS / 60000)} minutes.` });
    }, CLI_TIMEOUT_MS);

    child.stdout?.on("data", (buf) => push(buf, out));
    child.stderr?.on("data", (buf) => push(buf, err));
    child.on("error", (error) => finish({ ok: false, text: `Copilot CLI error: ${error.message}` }));
    child.on("close", (code) => {
      const stdout = Buffer.concat(out).toString("utf8").trim();
      const stderr = Buffer.concat(err).toString("utf8").trim();
      if (code === 0) {
        finish({ ok: true, text: stdout || "(the command produced no output)" });
      } else {
        finish({ ok: false, text: stderr || stdout || `The Copilot CLI exited with code ${code}.` });
      }
    });
  });
}

/** The cwd a tool runs in: its `path` argument, else the server's own cwd. */
function resolveToolCwd(args) {
  const candidate = args && typeof args.path === "string" && args.path.trim() ? args.path : process.cwd();
  return path.resolve(candidate);
}

/**
 * Build the configured MCP server. Exported so tests can connect a client over
 * an in-memory transport. `seams.spawnImpl` lets a test intercept the CLI.
 */
export function createServer(seams = {}) {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions() }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = findTool(request.params.name);
    if (!tool) {
      return { isError: true, content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }] };
    }
    const args = request.params.arguments ?? {};
    const result = await runCli(tool.toArgv(args), resolveToolCwd(args), seams);
    return { isError: !result.ok, content: [{ type: "text", text: result.text }] };
  });

  return server;
}

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const isEntrypoint = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntrypoint) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
