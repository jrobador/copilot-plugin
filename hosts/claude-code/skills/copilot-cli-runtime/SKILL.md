---
name: copilot-cli-runtime
description: Internal helper contract for calling the copilot-plugin runtime from Claude Code
user-invocable: false
---

# Copilot Runtime

Use this skill only inside the `copilot:copilot-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/bin/copilot-plugin.mjs" task "<raw arguments>"`

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct Copilot CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel` from `copilot:copilot-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `copilot-prompting` skill to rewrite the user's request into a tighter Copilot prompt before the single `task` call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave `--effort` unset unless the user explicitly requests a specific effort.
- Leave model unset by default. Add `--model` only when the user explicitly asks for one.
- Pass aliases (`opus`, `sonnet`, `codex`, `gemini`) through unchanged; the plugin resolves them.
- Never add `--write` yourself. Forward it only when it is already in the request: `/copilot:rescue` settles write access with the user before routing. A run without it is read-only; Copilot reports the change as a diff.
- Never add `--unsafe-shell` or `--allow-wide-root` on your own; forward them only when the user typed them. The first hands Copilot an unfenced shell, the second lets a `--write` job treat your home directory or a drive root as its workspace.
- `--add-dir <path>` (repeatable) widens the job's fence to another directory: everything inside it becomes readable, and writable in a `--write` job. Forward it only when the user typed it; never add it yourself.

- Exit status 2 means the run was **degraded**: something it asked for was refused, so it did not see everything. Return the output verbatim with its banner, and never summarize the banner away or present the verdict as a clean result.
- `--dry-run` validates the root, the `--add-dir` list, the paths the prompt names, the model and PATH without contacting Copilot. Use it when a run looks likely to be refused; it costs nothing.
- Free text that starts with a dash must go after `--`. An unknown flag is now an error instead of silently becoming part of the prompt.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only. Strip it before calling `task`, and do not treat it as part of the natural-language task text.
- If the forwarded request includes `--model`, pass it through to `task` verbatim.
- If the forwarded request includes `--effort`, pass it through to `task`.
- If the forwarded request includes `--write`, pass it through to `task` verbatim.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `--resume`: always use `task --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `task` run, even if the request sounds like a follow-up.
- `--effort`: accepted values are `low`, `medium`, `high`, `xhigh`, `max`.
- `task --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous rescue run.

Available models:
- Do not carry a hardcoded list. The set depends on the account's entitlements
  and changes over time; `/copilot:setup` prints the current one.
- Aliases resolved by the plugin: `opus`, `sonnet`, `codex`, `gemini`.

Safety rules:
- Read-only unless `--write` was handed to you. Never escalate on your own.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or Copilot cannot be invoked, return nothing.
- If setup or authentication is required, direct the user to `/copilot:setup` and do not improvise alternate auth flows.
