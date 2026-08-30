---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Copilot rescue subagent
argument-hint: "[--background|--wait] [--write|--read-only] [--resume|--fresh] [--model <model>] [--effort <low|medium|high|xhigh|max>] [--unsafe-shell] [--allow-wide-root] [what Copilot should investigate, solve, or continue]"
context: fork
allowed-tools: Bash(node:*), AskUserQuestion
---

Route this request to the `copilot:copilot-rescue` subagent.
The final user-visible response must be Copilot's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `copilot:copilot-rescue` subagent in the background.
- If the request includes `--wait`, run the `copilot:copilot-rescue` subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `task`, and do not treat them as part of the natural-language task text.
- `--model` and `--effort` are runtime-selection flags. Preserve them for the forwarded `task` call, but do not treat them as part of the natural-language task text.

Write access:

- A rescue is read-only unless the user grants write access. Read-only means
  Copilot can read the repository and run read-only commands, and reports any
  change it would make as a diff instead of applying it.
- If the request includes `--write`, keep it. If it includes `--read-only`,
  strip that token and do not add `--write`. In both cases do not ask.
- Otherwise, decide whether the request asks Copilot to change files: verbs
  like fix, apply, implement, change, refactor, update, add, remove, migrate.
  Requests to investigate, diagnose, explain, research or review do not.
- If it does ask for changes, use `AskUserQuestion` exactly once, with these two
  options in this order:
  - `Let Copilot edit files (--write)`
  - `Read-only: report a diff instead`
- If the user chooses edit, add `--write` before routing to the subagent. If
  they choose read-only, route without it.
- If it does not ask for changes, do not ask; route without `--write`.
- This question may be combined with the resume question below into a single
  `AskUserQuestion` call with two questions, so the user is asked once.
- Never add `--unsafe-shell` or `--allow-wide-root` yourself; forward them only
  when the user typed them.

Continuing a previous rescue:

- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting Copilot, check for a resumable rescue thread from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current Copilot thread or start a new one.
- The two choices must be:
  - `Continue current Copilot thread`
  - `Start a new Copilot thread`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current Copilot thread (Recommended)` first.
- Otherwise put `Start a new Copilot thread (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new thread, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" task ...` and return that command's stdout as-is.
- Return the Copilot companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/copilot:status`, fetch `/copilot:result`, call `/copilot:cancel`, summarize output, or do follow-up work of its own.
- Leave `--effort` unset unless the user explicitly asks for a specific reasoning effort.
- Leave the model unset unless the user explicitly asks for one. Recognized aliases are `opus`, `sonnet`, `codex` and `gemini`; anything else is passed through as a literal model id. An id the account cannot use fails immediately with the list of valid ones.
- Leave `--write`, `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command, and never adds `--write` on its own.
- If the helper reports that Copilot is missing or unauthenticated, stop and tell the user to run `/copilot:setup`.
- If the user did not supply a request, ask what Copilot should investigate or fix.
