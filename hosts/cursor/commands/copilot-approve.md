Approve a paused Copilot job by calling the `copilot_approve` MCP tool with the
workspace path and, if the user named one, the `job_id`. The job resumes in the
background; point the user at `copilot_status` / `copilot_result`. Only approve
when the user has decided to; never approve on their behalf.
