Run a read-only Copilot review of the current work by calling the `copilot_review`
MCP tool with the workspace path. If the user named a base branch, pass it as
`base`. Present the tool's findings verbatim, ordered by severity, with file and
line. This is review-only: do not fix anything, and do not proceed to edits
without the user asking.
