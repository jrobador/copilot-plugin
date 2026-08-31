# Using the Copilot plugin in Cursor

The runtime is the same one Claude Code uses; Cursor talks to it over MCP. No server to host — Cursor spawns it on demand.

## 1. Install the runtime

```bash
npm install -g copilot-plugin
```

This puts `copilot-mcp` (the MCP server) and `copilot-plugin` (the CLI) on your PATH. Then authenticate Copilot once:

```bash
copilot login    # shares auth with the gh CLI; if you're signed in there, you're done
```

If you'd rather not install globally, clone this repo, run `npm install`, and use an absolute path to `bin/copilot-mcp.mjs` in step 2.

## 2. Register the MCP server

Copy `mcp.json` into your project's `.cursor/mcp.json` (or merge its `mcpServers` entry into an existing one):

```json
{ "mcpServers": { "copilot": { "command": "copilot-mcp" } } }
```

For a clone instead of a global install, use:

```json
{ "mcpServers": { "copilot": { "command": "node", "args": ["/abs/path/to/bin/copilot-mcp.mjs"] } } }
```

Reload Cursor. The `copilot_*` tools (review, rescue, status, result, approve, deny, cancel, setup) appear; Cursor asks before running a tool by default.

### Letting a rescue write

`copilot_rescue` is read-only over MCP: it reports the change it would make as a diff. Cursor confirms the tool call, but the arguments inside it come from the model, so `write: true` on its own is refused. The opt-in lives in the server's environment, which only you edit:

```json
{ "mcpServers": { "copilot": { "command": "copilot-mcp", "env": { "COPILOT_MCP_ALLOW_WRITE": "1" } } } }
```

`--unsafe-shell` and `--allow-wide-root` are not exposed over MCP at all. Run `copilot-plugin task` in a terminal if you need them.

## 3. (Optional) Commands and the rule

- Copy `commands/*.md` into `.cursor/commands/` for `/copilot-review`, `/copilot-rescue`, … slash commands.
- Copy `rules/copilot-plugin.mdc` into `.cursor/rules/` so the agent knows the tools are read-only by default and must not auto-apply review fixes.

## 4. (Optional) The stop-time review gate

Copy `hooks.json` into `.cursor/hooks.json` and replace `<COPILOT_PLUGIN_DIR>` with the directory that holds `bin/` (the global install dir, or your clone). With the gate enabled (`copilot_setup` → enable, or run `copilot-plugin setup --enable-review-gate` once), Cursor runs a Copilot review of each finished turn and blocks the stop only on an explicit finding. A clean working tree skips it, infrastructure failures never block, and it disables itself after two consecutive blocks.

## What's different from Claude Code

- Reviews and rescues are the same. Approvals work the same (`copilot_approve` / `copilot_deny`).
- Jobs are scoped to the workspace, not the individual Cursor conversation, so `copilot_status` shows the repository's jobs. (Claude Code scopes them per session.)
