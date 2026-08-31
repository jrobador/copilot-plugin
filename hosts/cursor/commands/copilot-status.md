Show Copilot jobs for this repository by calling the `copilot_status` MCP tool
with the workspace path. Pass a `job_id` for one job, or `all: true` for every
session's jobs. Render the output as-is; if a job is `awaiting-approval`, surface
it and remind the user they can approve or deny it.
