# Copilot plugin for Claude Code

Delegate code review and coding tasks from Claude Code to GitHub Copilot.

Claude keeps driving the session; Copilot does the work you hand it and its
output comes back verbatim. A second model reviewing your change catches things
the model that wrote it will not.

## What you get

| Command | What it does |
|---|---|
| `/copilot:review` | Read-only review of your uncommitted changes or your branch |
| `/copilot:adversarial-review` | Steerable review that challenges the design, not just the code |
| `/copilot:rescue` | Hand a task to Copilot: investigate, diagnose, or fix |
| `/copilot:status` | Running and recent jobs for this repository |
| `/copilot:result` | Final output of a finished job |
| `/copilot:cancel` | Stop a background job |
| `/copilot:setup` | Check readiness, list models, toggle the review gate |

Reviews and rescues can run in the background, so a long review does not block
your session.

## Requirements

- **A GitHub account with Copilot access.** Usage counts against your Copilot
  limits. See [subscription plans](https://docs.github.com/en/copilot/about-github-copilot/subscription-plans-for-github-copilot).
- **Node.js 20 or later.**

You do **not** need a global Copilot CLI install: the plugin talks to Copilot
through `@github/copilot-sdk`, which ships the CLI as a dependency. If you
already have `copilot` on your PATH, that one is used instead.

## Install

```bash
/plugin marketplace add jrobador/copilot-plugin-cc
/plugin install copilot@copilot-plugin-cc
/reload-plugins
/copilot:setup
```

`/copilot:setup` reports whether the runtime is available, whether you are
authenticated, and which models your account can use.

If you are not signed in:

```bash
!copilot login
```

`copilot login` also accepts `--device-code` when browser login is blocked, and
`--with-token` to read a token from stdin. Authentication is shared with the
`gh` CLI, so if you are already signed in there you are likely done.

A first run:

```bash
/copilot:review --background
/copilot:status
/copilot:result
```

## Usage

### `/copilot:review`

Reviews your current work and returns findings ordered by severity.

Copilot receives the diff **and** read access to the repository, so it opens the
files around a change instead of judging hunks in isolation. That is what
catches the change that is locally correct but wrong for its callers.

```bash
/copilot:review                          # working tree
/copilot:review --base main              # branch vs. base
/copilot:review --background
/copilot:review --model opus             # pick who reviews
```

Multi-file reviews take a while; `--background` is usually the right call.

### `/copilot:adversarial-review`

Same targeting, different posture: it tries to find reasons the change should
not ship. Auth and tenant isolation, data loss, rollback safety, races, version
skew, and whether a different approach would have been simpler.

Unlike `/copilot:review`, it takes free-text focus after the flags.

```bash
/copilot:adversarial-review
/copilot:adversarial-review --base main challenge the caching and retry design
/copilot:adversarial-review --background look for race conditions
```

### `/copilot:rescue`

Hands a task to Copilot through the `copilot:copilot-rescue` subagent.

```bash
/copilot:rescue investigate why the tests started failing
/copilot:rescue --resume apply the top fix from the last run
/copilot:rescue --model sonnet --effort high investigate the flaky integration test
/copilot:rescue --background investigate the regression
```

Or just ask in prose: *"Ask Copilot to redesign the database connection to be
more resilient."*

Rescue is the one command that can edit your files, and only when Copilot is
given write access. It supports `--background`, `--wait`, `--resume` and
`--fresh`; with neither `--resume` nor `--fresh`, the plugin offers to continue
the latest rescue thread for the repository.

### `/copilot:status`, `/copilot:result`, `/copilot:cancel`

```bash
/copilot:status                 # everything in this repo
/copilot:status task-abc123
/copilot:result                 # latest finished job
/copilot:cancel task-abc123
```

`/copilot:result` includes the Copilot session id, so you can pick the work up
directly in Copilot with `copilot --resume <session-id>`.

### `/copilot:setup`

Reports Node, the Copilot runtime, authentication, and the models available to
your account. It also manages the optional review gate:

```bash
/copilot:setup --enable-review-gate
/copilot:setup --disable-review-gate
```

With the gate enabled, a `Stop` hook runs a targeted Copilot review of the turn
Claude just finished and blocks the stop if it finds something that should be
fixed first.

> [!WARNING]
> The review gate can create a long-running Claude/Copilot loop and drain usage
> limits quickly. Enable it only when you are watching the session.

## Choosing the model

This is the part with no equivalent on the Codex side. Copilot exposes every
model your account is entitled to, and any of them can do the reviewing:

```bash
/copilot:review --model opus
/copilot:adversarial-review --model gpt-5.6-sol
/copilot:rescue --model gemini investigate the regression
```

Aliases: `opus`, `sonnet`, `codex`, `gemini`. Anything else is passed through as
a literal model id, and an unknown id fails immediately with the list of valid
ones rather than dying mid-run. `/copilot:setup` prints the full list.

`--effort` (`low`, `medium`, `high`, `xhigh`, `max`) applies to
models that support reasoning effort.

## Permissions

Every privileged action Copilot attempts is decided by the plugin, not by the
prompt.

**Read-only jobs** — both reviews, and any rescue without write access:

| Request | Decision |
|---|---|
| Read a file | allowed |
| Shell command the runtime classified as read-only | allowed |
| Write a file | refused |
| Shell command that can mutate state, or redirects to a file | refused |
| Network access | refused |
| MCP tool not declared read-only | refused |

**Write-capable rescues** additionally allow writes, mutating commands and
network access, scoped to the workspace.

**Refused in both modes**: sandbox escapes, and writes to Copilot's persistent
memory — a delegated job should not quietly change what Copilot remembers about
you.

Denials are reported in the job output, so a review that could not run something
tells you so instead of silently working around it.

## How it works

```
Claude Code
  └─ slash command (.md, mostly prompt)
       └─ scripts/copilot-companion.mjs        one CLI: setup|review|task|status|result|cancel
            ├─ lib/copilot-client.mjs          @github/copilot-sdk over JSON-RPC
            │    └─ lib/permissions.mjs        decides every permission request
            ├─ lib/git.mjs                     review targeting and diff collection
            └─ lib/state.mjs                   per-workspace job records
```

The commands hold almost no logic: they decide foreground vs. background and
return the companion's stdout verbatim. Everything else is in the Node runtime,
which is testable without Claude Code in the loop (`npm test`).

Job state lives per workspace under `$CLAUDE_PLUGIN_DATA/state/`, keyed by a
hash of the workspace path, capped at 50 jobs.

## Configuration

The plugin uses your existing Copilot configuration:

- user-level `~/.copilot/config.toml`
- project-level `.copilot/config.toml` (only when the project is trusted)

```toml
model = "gpt-5.4"
model_reasoning_effort = "high"
```

Flags passed to a command override the config for that run.

## FAQ

**Do I need a separate account?**
No. The plugin uses your machine's existing Copilot authentication, including
`gh` CLI credentials.

**Does it run its own Copilot?**
It manages a Copilot CLI process through `@github/copilot-sdk`, using your
install if you have one and the bundled one otherwise. Same authentication, same
config, same checkout.

**Can a review edit my code?**
No. Reviews run under a permission policy that refuses writes at the runtime
level. Only `/copilot:rescue` with write access can change files.

## Development

```bash
npm install
npm test
```

## Credits

This project is a derivative work, Apache-2.0 throughout:

- [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) — the
  original Codex plugin whose structure this follows.
- [wagnersza/copilot-plugin-cc](https://github.com/wagnersza/copilot-plugin-cc)
  — the first port to Copilot, which this was seeded from.

See [NOTICE](NOTICE) for the full attribution chain. Not affiliated with GitHub,
Microsoft, OpenAI, or Anthropic.
