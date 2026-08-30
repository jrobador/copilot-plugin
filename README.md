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
| `/copilot:rescue` | Hand a task to Copilot: investigate, diagnose, or fix (read-only unless you grant `--write`) |
| `/copilot:status` | Running, paused and recent jobs for this repository |
| `/copilot:result` | Final output of a finished job |
| `/copilot:approve` / `/copilot:deny` | Decide on a job that paused for your permission |
| `/copilot:cancel` | Stop a background or paused job |
| `/copilot:setup` | Install the runtime, check readiness, list models, toggle the review gate |

Reviews and rescues can run in the background, so a long review does not block
your session.

## Requirements

- **A GitHub account with Copilot access.** Usage counts against your Copilot
  limits. See [subscription plans](https://docs.github.com/en/copilot/about-github-copilot/subscription-plans-for-github-copilot).
- **Node.js 20 or later.**

You do **not** need a global Copilot CLI install: the plugin talks to Copilot
through `@github/copilot-sdk`, which ships the CLI as a dependency and which
`/copilot:setup` installs into the plugin directory for you. If you already
have `copilot` on your PATH, that one is used instead.

## Install

```bash
/plugin marketplace add jrobador/copilot-plugin-cc
/plugin install copilot@copilot-plugin-cc
/reload-plugins
/copilot:setup
```

On a fresh install `/copilot:setup` finds no runtime and offers to install it
(`npm install` into the plugin's own directory, nothing global). Accept, or run
`/copilot:setup --install-runtime` yourself. A plugin update can replace that
directory; if it does, `/copilot:setup` offers again.

`/copilot:setup` reports whether the runtime is installed, whether you are
authenticated, and which models your account can use.

If you are not signed in:

```bash
!copilot login
```

`copilot login` also accepts `--device-code` when browser login is blocked, and
`--with-token` to read a token from stdin. Authentication is shared with the
`gh` CLI, so if you are already signed in there you are likely done.

### Known issues (0.1.1-dev)

Being fixed in this release; until then:

- **The review gate blocks the session end on any failure**, including a
  logged-out Copilot. If it loops, run `/copilot:setup --disable-review-gate`.

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
/copilot:rescue --write fix the flaky integration test
/copilot:rescue --resume apply the top fix from the last run
/copilot:rescue --model sonnet --effort high investigate the flaky integration test
/copilot:rescue --background investigate the regression
```

Or just ask in prose: *"Ask Copilot to redesign the database connection to be
more resilient."*

Rescue is the one command that can edit your files, and only when you grant
write access. A rescue is **read-only by default**: Copilot reads the
repository, runs read-only commands, and reports any change it would make as
a diff. Pass `--write` to let it apply changes, or `--read-only` to be
explicit. When a request reads like a change ("fix", "apply", "refactor") and
you passed neither, `/copilot:rescue` asks once before starting; a rescue that
Claude starts on its own initiative is always read-only.

It supports `--background`, `--wait`, `--resume` and `--fresh`; with neither
`--resume` nor `--fresh`, the plugin offers to continue the latest rescue
thread for the repository.

### `/copilot:status`, `/copilot:result`, `/copilot:cancel`

```bash
/copilot:status                 # everything in this repo
/copilot:status task-abc123
/copilot:result                 # latest finished job
/copilot:cancel task-abc123
```

`/copilot:result` includes the Copilot session id, so you can pick the work up
directly in Copilot with `copilot --resume <session-id>`.

### `/copilot:approve`, `/copilot:deny`

A job can pause on a decision that should be yours. When the permission policy
flags a request for the owner, the job stops with status `awaiting-approval`,
keeps its Copilot session, and `/copilot:status` shows what it wants to do:

```bash
/copilot:status                 # "Awaiting your approval: read: secrets/.env"
/copilot:approve task-abc123    # resume the same session with that request allowed
/copilot:deny task-abc123       # close the job without granting it
/copilot:cancel task-abc123     # abandon it without deciding
```

Approving resumes the paused Copilot session in the background and asks the
model to carry out the request it was refused; the rest of the task continues
from there. If the CLI has since pruned that session the job ends as
`expired` and the original task has to be re-run. A paused job is never
pruned from the job list while it waits.

What pauses a job today is a sentinel filename, `ESCALATE_ME.txt`
(override with the `COPILOT_ESCALATE_SENTINEL` environment variable); a
classifier for secret-looking files is the planned follow-up. Everything the
policy refuses outright is still refused, not escalated.

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
prompt. Write access is granted by you, per rescue, with `--write`; nothing
else turns it on.

**Read-only jobs** — both reviews, and any rescue without `--write`:

| Request | Decision |
|---|---|
| Read a file inside the workspace | allowed |
| `run_command` with `git` (read subcommands) or `rg` | allowed |
| Write a file | refused |
| `run_command` with any other program, or a git subcommand that mutates | refused |
| Network access | refused |
| MCP tool not declared read-only | refused |
| Read or write a path outside the workspace (after resolving `..`, symlinks and Windows short names) | refused |

**Write-capable rescues** additionally allow writes, network access, and
`run_command` with the common toolchains. Writes are confined to the workspace
root: the git top level, or the `-C` directory when there is no repository.

**Refused in both modes**: reads and writes outside the workspace, command
arguments that name paths outside it, writes to `.git/`, `.github/workflows/`,
`.husky/` and `.vscode/tasks.json` (they run code on your behalf later), writes
to files hardlinked elsewhere, and writes to Copilot's persistent memory — a
delegated job should not quietly change what Copilot remembers about you.

A `--write` job is also refused when its workspace root is your home directory,
an ancestor of it, or a drive root, because "inside the workspace" would then
mean everything you own. Pass `--allow-wide-root` if you really mean it.

### Shell

Copilot's runtime ships shell tools (`bash` on Unix, `powershell` on Windows,
plus their read/write/stop/list helpers). They hand the model an interpreter,
and an interpreter cannot be fenced by reading its input: bash and PowerShell
are different languages, and on Windows the runtime does not even try to
extract paths from PowerShell. So every session removes those tools and
registers `run_command` instead.

`run_command` takes a program name and an argument list and spawns exactly
that — no shell, so no pipes, redirection, `&&`, `cd`, globbing or variable
expansion, on any OS. It runs in the job directory with an environment
scrubbed of `GIT_DIR`-style relocation variables, `NODE_OPTIONS`, and
`npm_config_*`, and it kills the process tree after ten minutes.

| Mode | Programs |
|---|---|
| read-only | `git` (`log diff show status blame grep ls-files rev-parse branch describe shortlog cat-file remote`; `branch`/`remote` in listing form only), `rg` |
| `--write` | `git npm pnpm yarn npx node python python3 pytest dotnet cargo go make rg ls`, plus anything added with `/copilot:setup --allow-programs a,b,c` |

Every argument that looks like a path is resolved and must land inside the
workspace. Options that relocate a program or make it evaluate inline code are
refused in both modes: `git -C`/`--git-dir`/`-c` before the subcommand,
`node -e`/`-r`/`--import`, `python -c`, `npm --prefix`/`-g`, `make -C`/`-f`,
`cargo --manifest-path`, `go -C`, `rg --pre`, and the like.

`--unsafe-shell` on a rescue restores the runtime's own shell tools. The job
record and the output say so (`Shell: unfenced`). Claude never adds this flag
on its own.

**What this does not do.** `run_command` fences what Copilot can invoke, not
what the invoked program does. `npm test`, `node script.js`, `make` and git
hooks in the repository run with your full user privileges and network access;
nothing short of an OS sandbox closes that, and this plugin does not provide
one. Windows has no built-in equivalent.

Denials are reported in the job output, so a review that could not run something
tells you so instead of silently working around it.

## How it works

```
Claude Code
  └─ slash command (.md, mostly prompt)
       └─ scripts/copilot-companion.mjs        one CLI: setup|review|task|status|result|cancel
            ├─ lib/copilot-client.mjs          @github/copilot-sdk over JSON-RPC
            │    ├─ lib/permissions.mjs        decides every permission request
            │    └─ lib/run-command.mjs        the argv-only shell replacement
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
npm install        # test and typecheck tooling
npm run deps       # the Copilot runtime, into plugins/copilot/node_modules
npm test
npm run typecheck
```

The runtime lives in `plugins/copilot/package.json`, not the root one, because
`plugins/copilot` is what the marketplace ships. The suite runs without it
against `tests/fake-copilot-fixture.mjs` (`COPILOT_COMPANION_SDK_MODULE`).

## Credits

This project is a derivative work, Apache-2.0 throughout:

- [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) — the
  original Codex plugin whose structure this follows.
- [wagnersza/copilot-plugin-cc](https://github.com/wagnersza/copilot-plugin-cc)
  — the first port to Copilot, which this was seeded from.

See [NOTICE](NOTICE) for the full attribution chain. Not affiliated with GitHub,
Microsoft, OpenAI, or Anthropic.
