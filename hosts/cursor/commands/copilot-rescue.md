Hand this task to Copilot by calling the `copilot_rescue` MCP tool with the
workspace path and the user's request as `prompt`.

- Keep it **read-only** (omit `write`) for investigate / diagnose / explain /
  research. Set `write: true` only when the user asked Copilot to change files.
- For a long or open-ended task, pass `background: true`, tell the user the job
  id, and use `copilot_status` / `copilot_result` to follow up.
- To continue the previous rescue, pass `resume: true`.

Return Copilot's output verbatim. If it edited files, say so and list them.
