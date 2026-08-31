---
description: Check whether the Copilot runtime is installed and authenticated, install it, and toggle the stop-time review gate
argument-hint: '[--install-runtime] [--enable-review-gate|--disable-review-gate] [--allow-programs a,b,c|--clear-allowed-programs]'
allowed-tools: Bash(node:*), AskUserQuestion
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/copilot-plugin.mjs" setup $ARGUMENTS`

The report above is the user's setup status — present it as-is; do not summarize or drop lines.

The runtime is `@github/copilot-sdk`, which bundles the Copilot CLI. It is not shipped with the plugin; `setup --install-runtime` installs it into the plugin directory with npm, which is the only place an installed plugin can resolve it from.

Only if the report says the runtime is **not installed** and npm is available:
- Use `AskUserQuestion` exactly once, install option first, suffixed `(Recommended)`:
  - `Install the Copilot runtime into the plugin directory (Recommended)`
  - `Skip for now`
- If the user chooses install, run this with Bash and present its output:
  `node "${CLAUDE_PLUGIN_ROOT}/bin/copilot-plugin.mjs" setup --install-runtime`
- Never run `npm install` yourself, and never `npm install -g`: a global install is not on the plugin's resolution path and will not fix anything.

If the report already shows `Status: ready`, there is nothing to do. If the runtime is installed but not authenticated, tell the user to run `!copilot login`.
