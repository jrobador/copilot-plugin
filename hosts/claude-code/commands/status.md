---
description: Show active and recent Copilot jobs for this repository, including review-gate status
argument-hint: '[job-id] [--wait] [--timeout-ms <ms>] [--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/copilot-plugin.mjs" status $ARGUMENTS`

If the user did not pass a job ID:
- Render the command output as a single Markdown table for the current and past runs in this session.
- Keep it compact. Do not include progress blocks or extra prose outside the table.
- Preserve the actionable fields from the command output, including job ID, kind, status, phase, elapsed or duration, summary, and follow-up commands.
- If any job is in the "Awaiting your approval" section, surface it prominently: name what it wants to do and remind the user they can run `/copilot:approve <id>` to allow it or `/copilot:deny <id>` to refuse. These jobs are paused, not finished — they resume only after approval.

If the user did pass a job ID:
- Present the full command output to the user.
- Do not summarize or condense it.
