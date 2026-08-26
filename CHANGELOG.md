# Changelog

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
- Denied requests are reported in the job output instead of failing silently.

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

### Added

- `--model` and `--effort` on both review commands. Copilot exposes every model
  the account is entitled to, so the reviewer no longer has to be the default
  model. Aliases: `opus`, `sonnet`, `codex`, `gemini`.
- An unavailable model id fails before the session starts, listing valid ids.
- `/copilot:setup` lists the models the account can use.
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
