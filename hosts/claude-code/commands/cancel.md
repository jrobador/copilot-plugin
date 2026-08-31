---
description: Cancel an active background Copilot job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/copilot-plugin.mjs" cancel $ARGUMENTS`
