---
description: Check whether the Copilot runtime is installed and authenticated, install it, and toggle the stop-time review gate
argument-hint: '[--install-runtime] [--enable-review-gate|--disable-review-gate] [--allow-programs a,b,c|--clear-allowed-programs]'
allowed-tools: Bash(node:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" setup --json $ARGUMENTS
```

The runtime is `@github/copilot-sdk`, which bundles the Copilot CLI. It is not
shipped with the plugin; `setup --install-runtime` installs it into the plugin
directory with npm, which is the only place an installed plugin can resolve it
from.

If the result has `sdk.available: false` and `npm.available: true`:
- Use `AskUserQuestion` exactly once to ask whether Claude should install the runtime now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install the Copilot runtime into the plugin directory (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" setup --install-runtime --json $ARGUMENTS
```

- Present that output. Do not run `npm install` yourself, and never
  `npm install -g`: a global install is not on the plugin's resolution path
  and will not fix anything.

If `sdk.available` is true, or npm is unavailable:
- Do not ask about installation. If npm is unavailable, say that Node.js and
  npm are required and stop.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If the runtime is installed but not authenticated, preserve the guidance to run `!copilot login`.
