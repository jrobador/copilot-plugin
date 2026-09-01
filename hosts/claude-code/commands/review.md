---
description: Run a Copilot code review against local git state
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <model>] [--effort <level>]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a Copilot review through the shared built-in reviewer.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Copilot's output verbatim to the user.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run the review in the foreground.
- If the raw arguments include `--background`, do not ask. Run the review in a Claude background task.
- Otherwise, estimate the review size before asking:
  - For working-tree review, start with `git status --short --untracked-files=all`.
  - For working-tree review, also inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work even when `git diff --shortstat` is empty.
  - Only conclude there is nothing to review when the relevant working-tree status is empty or the explicit branch diff is empty.
  - Recommend waiting only when the review is clearly tiny, roughly 1-2 files total and no sign of a broader directory-sized change.
  - In every other case, including unclear size, recommend background.
  - When in doubt, run the review instead of declaring that there is nothing to review.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Preserve the user's arguments exactly.
- Do not strip `--wait` or `--background` yourself.
- Do not add extra review instructions or rewrite the user's intent.
- The plugin script parses `--wait` and `--background`, but Claude Code's `Bash(..., run_in_background: true)` is what actually detaches the run.
- `/copilot:review` does not support staged-only review, unstaged-only review, or extra focus text.
- If the user needs custom review instructions or more adversarial framing, they should use `/copilot:adversarial-review`.
- `--model` picks which model reviews the code. Leave it unset unless the user asks for one. Aliases: `opus`, `sonnet`, `codex`, `gemini`. Run `/copilot:setup` to list what the account can use.
- `--effort` sets reasoning effort (`low`, `medium`, `high`, `xhigh`, `max`) on models that support it. Leave it unset unless the user asks.

The review does not run read-only any more: it runs in `workspace-execute`, so Copilot may run the repository's own commands — its test suite, one test, a linter, a type checker — to check its own conclusions. It still cannot change anything: writes, URL fetches and mutating git subcommands are refused by the plugin, not merely discouraged in the prompt. Pass `--read-only` to narrow it back to `git` and `rg`.

If the command exits with status 2, the run was **degraded**: something it asked for was refused, so it did not see everything. Return its output verbatim, banner included, and do not summarize the banner away — a clean verdict from a review that could not read the code is worse than no review.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/copilot-plugin.mjs" review "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.

Background flow:
- Launch the review with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/bin/copilot-plugin.mjs" review "$ARGUMENTS"`,
  description: "Copilot review",
  run_in_background: true
})
```
- Do not call `BashOutput` or wait for completion in this turn.
- After launching the command, tell the user: "Copilot review started in the background. Check `/copilot:status` for progress."
