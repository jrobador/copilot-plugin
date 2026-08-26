# Copilot plugin for Claude Code

Use Copilot from inside Claude Code for code reviews or to delegate tasks to Copilot.

This plugin is for Claude Code users who want an easy way to start using Copilot from the workflow
they already have.

<video src="./docs/plugin-demo.webm" controls muted playsinline autoplay></video>

## What You Get

- `/copilot:review` for a normal read-only Copilot review
- `/copilot:adversarial-review` for a steerable challenge review
- `/copilot:rescue`, `/copilot:status`, `/copilot:result`, and `/copilot:cancel` to delegate work and manage background jobs

## Requirements

- **GitHub Copilot subscription or GitHub token.**
  - Usage will contribute to your Copilot usage limits. [Learn more](https://docs.github.com/en/copilot/about-github-copilot/subscription-plans-for-github-copilot).
- **Node.js 18.18 or later**

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add wagnersza/copilot-plugin-cc
```

Install the plugin:

```bash
/plugin install copilot@wagnersza
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/copilot:setup
```

`/copilot:setup` will tell you whether Copilot is ready. If Copilot is missing and npm is available, it can offer to install Copilot for you.

If you prefer to install Copilot yourself, use:

```bash
npm install -g @github/copilot-cli
```

If Copilot is installed but not logged in yet, run:

```bash
!copilot auth login
```

After install, you should see:

- the slash commands listed below
- the `copilot:copilot-rescue` subagent in `/agents`

One simple first run is:

```bash
/copilot:review --background
/copilot:status
/copilot:result
```

## Usage

### `/copilot:review`

Runs a normal Copilot review on your current work. It gives you the same quality of code review as running `/review` inside Copilot directly.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. It is not steerable and does not take custom focus text. Use [`/copilot:adversarial-review`](#copilotadversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/copilot:review
/copilot:review --base main
/copilot:review --background
```

This command is read-only and will not perform any changes. When run in the background you can use [`/copilot:status`](#copilotstatus) to check on the progress and [`/copilot:cancel`](#copilotcancel) to cancel the ongoing task.

### `/copilot:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/copilot:review`, including `--base <ref>` for branch review.
It also supports `--wait` and `--background`. Unlike `/copilot:review`, it can take extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/copilot:adversarial-review
/copilot:adversarial-review --base main challenge whether this was the right caching and retry design
/copilot:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/copilot:rescue`

Hands a task to Copilot through the `copilot:copilot-rescue` subagent.

Use it when you want Copilot to:

- investigate a bug
- try a fix
- continue a previous Copilot task
- take a faster or cheaper pass with a smaller model

> [!NOTE]
> Depending on the task and the model you choose these tasks might take a long time and it's generally recommended to force the task to be in the background or move the agent to the background.

It supports `--background`, `--wait`, `--resume`, and `--fresh`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue thread for this repo.

Examples:

```bash
/copilot:rescue investigate why the tests started failing
/copilot:rescue fix the failing test with the smallest safe patch
/copilot:rescue --resume apply the top fix from the last run
/copilot:rescue --model gpt-5.4 --effort medium investigate the flaky integration test
/copilot:rescue --model spark fix the issue quickly
/copilot:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to Copilot:

```text
Ask Copilot to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model` or `--effort`, Copilot chooses its own defaults.
- if you say `spark`, the plugin maps that to `gpt-5.3-codex-spark`
- follow-up rescue requests can continue the latest Copilot task in the repo

### `/copilot:status`

Shows running and recent Copilot jobs for the current repository.

Examples:

```bash
/copilot:status
/copilot:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

### `/copilot:result`

Shows the final stored Copilot output for a finished job.
When available, it also includes the Copilot session ID so you can reopen that run directly in Copilot with `copilot resume <session-id>`.

Examples:

```bash
/copilot:result
/copilot:result task-abc123
```

### `/copilot:cancel`

Cancels an active background Copilot job.

Examples:

```bash
/copilot:cancel
/copilot:cancel task-abc123
```

### `/copilot:setup`

Checks whether Copilot is installed and authenticated.
If Copilot is missing and npm is available, it can offer to install Copilot for you.

You can also use `/copilot:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/copilot:setup --enable-review-gate
/copilot:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted Copilot review based on Claude's response. If that review finds issues, the stop is blocked so Claude can address them first.

> [!WARNING]
> The review gate can create a long-running Claude/Copilot loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

## Typical Flows

### Review Before Shipping

```bash
/copilot:review
```

### Hand A Problem To Copilot

```bash
/copilot:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/copilot:adversarial-review --background
/copilot:rescue --background investigate the flaky test
```

Then check in with:

```bash
/copilot:status
/copilot:result
```

## Copilot Integration

The Copilot plugin wraps the [Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli). It uses `@github/copilot-sdk` for ACP (Agent Communication Protocol) communication with the Copilot backend and [applies the same configuration](https://docs.github.com/en/copilot/configuring-github-copilot).

### Supported Models

The plugin supports the following models:

- `GPT-5.4` — latest high-capability model
- `GPT-5.3-Codex` — optimized for code tasks
- `Gemini 3.1 Pro` — Google's advanced reasoning model

### Common Configurations

If you want to change the default reasoning effort or the default model that gets used by the plugin, you can define that inside your user-level or project-level `config.toml`. For example to always use `gpt-5.4` on `high` for a specific project you can add the following to a `.copilot/config.toml` file at the root of the directory you started Claude in:

```toml
model = "gpt-5.4"
model_reasoning_effort = "xhigh"
```

Your configuration will be picked up based on:

- user-level config in `~/.copilot/config.toml`
- project-level overrides in `.copilot/config.toml`
- project-level overrides only load when the [project is trusted](https://docs.github.com/en/copilot/configuring-github-copilot)

Check out the Copilot docs for more [configuration options](https://docs.github.com/en/copilot).

### Moving The Work Over To Copilot

Delegated tasks and any [stop gate](#what-does-the-review-gate-do) run can also be directly resumed inside Copilot by running `copilot resume` either with the specific session ID you received from running `/copilot:result` or `/copilot:status` or by selecting it from the list.

This way you can review the Copilot work or continue the work there.

## FAQ

### Do I need a separate Copilot account for this plugin?

If you are already signed into Copilot on this machine, that account should work immediately here too. This plugin uses your local Copilot CLI authentication.

If you only use Claude Code today and have not used Copilot yet, you will also need to sign in to Copilot with a GitHub account. [Copilot is available with various GitHub subscription plans](https://docs.github.com/en/copilot/about-github-copilot/subscription-plans-for-github-copilot), and `copilot auth login` supports GitHub sign-in. Run `/copilot:setup` to check whether Copilot is ready, and use `!copilot auth login` if it is not.

### Does the plugin use a separate Copilot runtime?

No. This plugin delegates through your local `@github/copilot-cli` and uses `@github/copilot-sdk` for ACP communication on the same machine.

That means:

- it uses the same Copilot install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

### Will it use the same Copilot config I already have?

Yes. If you already use Copilot, the plugin picks up the same [configuration](#common-configurations).

### Can I keep using my current token or base URL setup?

Yes. Because the plugin uses your local Copilot CLI, your existing sign-in method and config still apply.

If you need to point the built-in provider at a different endpoint, set `base_url` in your [Copilot config](https://docs.github.com/en/copilot/configuring-github-copilot).
