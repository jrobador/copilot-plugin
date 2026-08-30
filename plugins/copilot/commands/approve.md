---
description: Approve a Copilot job that paused waiting for your permission
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" approve $ARGUMENTS`

Present the command output to the user. The approved job resumes in the
background; point them at `/copilot:status <id>` for progress and
`/copilot:result <id>` once it finishes. If the job cannot be resumed because its
Copilot session expired, tell the user to re-run the original task.
