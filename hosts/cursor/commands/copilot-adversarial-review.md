Run a challenge review by calling the `copilot_adversarial_review` MCP tool with
the workspace path. Pass any free-text focus the user gave as `focus` (e.g. auth,
data loss, races, rollback). Present the tool's findings verbatim, ordered by
severity. Review-only: do not fix anything without the user asking.
