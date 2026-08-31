Check the Copilot runtime by calling the `copilot_setup` MCP tool with the
workspace path. If it reports the runtime missing, pass `install_runtime: true`
to install it, then present the result. If it is installed but not authenticated,
tell the user to run `copilot login` in a terminal.
