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
- `--add-dir <path>` (repeatable) widens the job's fence to another directory: everything inside it becomes readable, and writable in a `--write` job. You may pass it for a directory the user named in their request, even if they did not type the flag — for example when a previous run failed with the fence error that names that path. Never add a directory the user did not mention, and never one you picked yourself: a prompt you wrote naming a path you then grant yourself access to is a self-escalation loop, not a fix.

- Exit status 2 means the run was **degraded**: something it asked for was refused, so it did not see everything. Return the output verbatim with its banner, and never summarize the banner away or present the verdict as a clean result.
- `--dry-run` validates the root, the `--add-dir` list, the paths the prompt names, the model and PATH without contacting Copilot. Use it when a run looks likely to be refused; it costs nothing.
- Before launching more than one job in parallel with the same invocation shape, run one of them with `--dry-run` first. N parallel runs sharing one undiscovered defect cost N times what discovering it once costs.
- Free text that starts with a dash must go after `--`. An unknown flag is now an error instead of silently becoming part of the prompt.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- If the forwarded request includes `--wait`, strip it: `task` blocks by default.
- If the forwarded request includes `--background`, pass it to `task`. The plugin detaches the job and prints its id, plus the `watch` and `result` commands for it. Return that output as-is. Never run the Bash call itself in the background, and never wait for the job.
- In neither case is the flag part of the natural-language task text.
- If the forwarded request includes `--model`, pass it through to `task` verbatim.
- If the forwarded request includes `--effort`, pass it through to `task`.
- If the forwarded request includes `--write`, pass it through to `task` verbatim.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `--resume`: always use `task --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `task` run, even if the request sounds like a follow-up.
- `--effort`: accepted values are `low`, `medium`, `high`, `xhigh`, `max`.
- `task --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous rescue run.

Following a background job (for the caller, not for `copilot:copilot-rescue`):
- A detached job has no stdout anyone reads. Follow it with `node "${CLAUDE_PLUGIN_ROOT}/bin/copilot-plugin.mjs" watch <job-id> --cwd <workspace>`, run as a Claude Code `Monitor`: every stdout line becomes a notification while the job runs.
- `watch` prints only what is worth acting on: `CMD` (a command and its exit code), `DENIED` (a refused request), `PAUSED` (a request escalated to the owner), `BEAT` (elapsed time and Copilot's latest narration, every 3 minutes), `SILENT` (no activity for 5 minutes), and a final `END` line that names the command to run next.
- A repeated failing `CMD` or an early `DENIED` means the job is working blind: cancel it with `cancel <job-id>` and relaunch with the cause fixed, instead of waiting for the turn timeout.
- On `END`, run `result <job-id> --cwd <workspace>`. On `END status=awaiting-approval`, the decision is the owner's: `approve` or `deny`.
- A `Monitor` expires after at most 30 minutes. Re-arm it with `watch <job-id> --since-now` so events already seen are not replayed.
- Successful `git status`, `diff`, `log`, `show` and `ls` are hidden; a failing one still shows. `--all-commands` shows them all.

Shaping a job (for the caller):
- One Copilot turn is capped at 30 minutes, and a job that hits the cap ends without a report. Size each job to finish well inside it: one repository, one concern. Several small jobs beat one large one, and can run in parallel.
- `--cwd` is the directory commands run in, not only the job's workspace. The fence is the enclosing git repository either way. Copilot cannot `cd`, and `npm --prefix` and `git -C` are refused, so point `--cwd` at the directory whose tools the job needs (the folder with the `package.json` it tests, for example).
- Two jobs that meet at a contract (a route, a payload, a file format) each get the contract verbatim in their prompt. Each side's tests mock the other, so a mismatch stays green on both.
- A write job may not stash, restore, check out a path or an existing branch, or switch branches: those hide or overwrite work the job shares its tree with. It may create a branch with `checkout -b` or `switch -c`.

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
