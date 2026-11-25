# In-process Plugins configured inline per Agent

Each **Agent** configures its own **Plugins** and **MCP Servers** inline in `config.yaml`, with no shared instances across **Agents**. **Plugins** run in-process through Node ESM `import()` as trusted **Operator** code and export a versioned contract (`apiVersion: 1`) typed by `@wheatley/sdk`. If a **Plugin** fails to load or an **MCP Server** fails to connect on start, Wheatley skips it, starts the **Agent** without it, and reports the error in **Agent** health.

## Considered Options

- Declare **Plugins** and **MCP Servers** once at the **Deployment** level and opt in per **Agent**: rejected. Inline configuration guarantees that each **Agent** owns its own instances, secrets, and connections with no shared state.
- Run every **Plugin** in a worker thread or child process: rejected. Only the **Operator** installs **Plugins**, in-process loading keeps **Frontend** streaming simple, and stdio **MCP Servers** already provide process isolation when needed.
- Fail **Agent** startup when one **Plugin** fails to load: rejected. One broken extension must not take the entire **Agent** offline.

## Consequences

- Each **Agent** owns its own **Plugin** instances and **MCP Server** connections and disposes of them when that **Agent** restarts.
- A **Plugin** crash outside a tool call can affect the daemon process, so Wheatley wraps every tool execution with input validation, a timeout (`AbortSignal`), and a concurrency gate.
- Two **Agents** that use the same **Plugin** or **MCP Server** repeat that block in `config.yaml`.
