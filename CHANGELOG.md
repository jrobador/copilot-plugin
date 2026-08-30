# Changelog

## 0.1.1 — unreleased

Hardening release driven by an audit of 0.1.0. Nothing here changes what the
commands do; it changes what can go wrong while they do it.

### Security

- **Git refs no longer reach a shell.** On Windows every child process went
  through cmd.exe (`shell: true`), which re-parses the joined arguments, and
  git accepts `&`, `|`, `;` and `$()` in ref names. A remote whose default
  branch was called `main|calc` would have run `calc` on the next
  `/copilot:review` with a clean tree; `--base` had the same hole. Programs
  are now spawned directly, with cmd.exe used only for `.cmd`/`.bat` shims and
  only with constant arguments, and every ref -- `--base` and the name behind
  `origin/HEAD` -- is validated (`assertSafeRef`) before it is used.

### Fixed

- `--resume` never resumed anything. The job recorded the **Claude Code**
  session id under `sessionId`, and the resume path handed that to Copilot as
  if it were the Copilot session id, so every continuation failed and started
  a fresh conversation named after Claude's session. The Copilot session is
  now stored on every finished job (`copilotSessionId`, also as `threadId`
  for the renderers), `--resume` and the resume prompt in `/copilot:rescue`
  look it up there, and a session the CLI has pruned falls back to a fresh one
  with a fresh id, saying so in the progress log.
- `/copilot:result` and `/copilot:status` printed no Copilot session id for
  finished jobs, and the resume hint they print used a `copilot resume`
  subcommand that does not exist; it is `copilot --resume <id>`.
- Two runs of the same prompt asked the CLI to create a session with the same
  id (every stop-gate review did). Session ids now carry a unique suffix.
- Background jobs could stay `queued` forever. The detached worker was
  spawned before its job record was written, so a fast worker found nothing,
  died with its stderr discarded, and the job never moved. The record is
  now written first, for both `task --background` and `/copilot:approve`,
  and a worker that cannot read or use its record marks the job `failed`
  with the reason instead of exiting silently.

### Added

- `/copilot:approve` and `/copilot:deny` for jobs that paused on a permission
  the owner should decide (`awaiting-approval`). A paused job keeps its Copilot
  session and resumes where it stopped once approved; denying closes it. The
  v1 trigger is a sentinel filename (`ESCALATE_ME.txt`, overridable with
  `COPILOT_ESCALATE_SENTINEL`).
- `npm run typecheck`: the JSDoc-typed sources are checked with `tsc` in CI.

### Tests

- Regression tests for every open audit finding land first, marked `todo`
  with the task that closes them, so the suite stays green while documenting
  what is still broken: shell injection through git refs on Windows, the
  unbounded review diff, backslashes eaten by the argument tokenizer,
  colliding session ids, unprotected `.claude/`, a corrupt `state.json`
  wiping the job index, and stale "running" jobs.
- CI installs with `npm ci` (lockfile enforced) instead of `npm install`.

## 0.1.0 — unreleased

First release of this fork. Seeded from
[wagnersza/copilot-plugin-cc](https://github.com/wagnersza/copilot-plugin-cc)
at `4837b0b`, itself a port of OpenAI's Codex plugin for Claude Code.

### Security

- **Read-only jobs are now actually read-only.** `--write` was parsed, recorded
  on the job and printed in the report, but never reached the session: every
  session ran with a permission handler that approved everything, so a review
  could edit the working tree. Permission requests are now decided by kind
  (`lib/permissions.mjs`): reads and runtime-classified read-only commands are
  allowed; writes, mutating commands, output redirection, network access and
  non-read-only MCP tools are refused. Sandbox escapes and writes to Copilot's
  persistent memory are refused in both modes, and unknown request kinds fail
  closed.
- **`--write` is confined to the workspace.** The write policy only checked the
  mode, and its "outside the workspace" guard relied on the SDK's
  `requestSandboxBypass` flag, which the runtime only sets when a host
  configures a sandbox — this plugin never did, so `--write` could edit any
  path on the machine. Every `read`, `write` and shell `possiblePaths` entry is
  now resolved (`lib/paths.mjs`: relative to the workspace, through `..`,
  symlinks, junctions and Windows 8.3 names, case-insensitively on Windows) and
  refused when it lands outside the git root, in both modes. Reads outside the
  workspace are refused too, since a write-capable job has network access and a
  read-only one still leaks the contents into the transcript. Touched files and
  denials are recorded on the job and shown under the task output.
- **The runtime's shell tools are replaced by `run_command`.** `bash`,
  `powershell` and their helpers hand the model an interpreter, and the
  runtime's own path extraction returns nothing for PowerShell, so a `--write`
  job could still write anywhere through the shell. Every session now excludes
  those tools and registers `run_command` (`lib/run-command.mjs`): one program
  from a per-mode allowlist, an argument list, no shell, cwd pinned to the job
  directory, environment scrubbed of `GIT_*` relocation variables,
  `NODE_OPTIONS` and `npm_config_*`, every path-looking argument resolved and
  confined to the workspace, options that relocate a program or evaluate inline
  code refused, output capped and the process tree killed on timeout. The same
  rules hold on Linux, macOS and Windows. Read-only jobs get `rg` and git's
  read subcommands, which also gives reviews on Windows a working shell for
  the first time. `--unsafe-shell` restores the runtime's tools and is
  recorded on the job.
- **Protected paths.** Writes to `.git/`, `.github/workflows/`, `.husky/` and
  `.vscode/tasks.json` are refused in both modes: inside the fence, but they run
  code on the user's behalf later.
- **Hardlinks.** A write to a file with more than one link is refused; the
  bytes would land in a file that lives somewhere else.
- **Wide roots.** A `--write` task whose workspace root is the home directory,
  an ancestor of it, or a drive root is refused unless `--allow-wide-root` is
  passed.
- Denied requests are reported in the job output instead of failing silently.
- Remaining limit, stated in the README: `run_command` fences what Copilot
  invokes, not what the invoked program does. Repository scripts and git hooks
  run with the user's privileges; only an OS sandbox closes that, and this
  plugin does not provide one.

### Fixed

- `/copilot:setup` reported success on machines that had never authenticated:
  the login check returned a hardcoded `loggedIn: true` with the detail
  "assumed authenticated". It now asks the SDK.
- Every command hung forever once it touched the runtime: the SDK's CLI child
  process kept the companion alive because nothing shut it down.
- Reviews died at 60 seconds with "Timeout waiting for session.idle" — the
  SDK's default. The timeout does not abort the agent, so short ones stranded
  work that was still running. Now 30 minutes.
- The progress log printed "Tool undefined completed" for every tool call:
  `tool.execution_complete` carries only a `toolCallId`, never a name.
- `getCopilotAvailability` only looked on PATH, so a working setup reported
  "not found" and blocked every command. The SDK ships a CLI as a dependency;
  that one is now found and used.
- `--effort` was parsed and dropped for tasks.
- Cancelling a finished job threw on non-English Windows: `taskkill`'s "process
  not found" was detected by matching English error text. Now by exit code 128.
- `binaryAvailable` read exit codes through cmd.exe, which is also localized. It
  now resolves the binary on PATH instead.
- `parseStructuredOutput` rejected fenced JSON, which models emit constantly.
- The review event listener was never disposed, leaking one per turn on resumed
  sessions.
- `resumeSession` falls back to a fresh session when the id has been pruned.
- `--effort` accepted `none` and `minimal` (Codex's set) and rejected `max`.
  The SDK's `ReasoningEffort` type is `low | medium | high | xhigh | max`:
  `minimal` passed our validation only to fail inside the SDK, and `max` was
  refused despite being valid. The set now matches the SDK exactly.

### Added

- `--model` and `--effort` on both review commands. Copilot exposes every model
  the account is entitled to, so the reviewer no longer has to be the default
  model. Aliases: `opus`, `sonnet`, `codex`, `gemini`.
- An unavailable model id fails before the session starts, listing valid ids.
- `/copilot:setup` lists the models the account can use.
- `--unsafe-shell` and `--allow-wide-root` on `/copilot:rescue`.
- `/copilot:setup --allow-programs a,b,c` and `--clear-allowed-programs` to
  extend the `--write` allowlist of `run_command` per workspace.
- The plain review is structured like the adversarial one, against
  `schemas/review-output.schema.json`. It was previously a one-line prompt with
  no schema, so its output could not be rendered or ordered by severity.
- Reviews attach the repository directory and run in plan mode, so Copilot opens
  the files around a change instead of judging pasted hunks in isolation.
- The output schema is injected into both review prompts. They referred to "the
  provided schema" while nothing provided it.
- `runPrompt` reports touched files, denied permissions, model and token count.

### Documentation

Corrected claims inherited from the Codex port that were not true of Copilot:
the install package (`@github/copilot-cli` is a 404, it is `@github/copilot`),
the login command (`copilot login`, not `copilot auth login`), its flags
(`--device-code` / `--with-token`), the `spark` alias (a Codex-only model), the
hardcoded three-model list, and the transport (JSON-RPC, not ACP).

Attribution now states the full derivation chain as Apache-2.0 requires;
upstream had replaced it with a bare "Copyright 2024 GitHub, Inc.".

### Tests

69 passing with 4 failing → 112 passing.
