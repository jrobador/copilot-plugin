---
description: Deny a Copilot job that paused waiting for your permission
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" deny $ARGUMENTS`

Present the command output to the user. Denying closes the job without granting
the paused request; the Copilot task does not continue.
