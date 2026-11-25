# Serialize durable Approvals per Run and apply live policy allows

When a **Permission Policy** rule evaluates to `ask`, the **Agent** serializes pending **Approvals** one at a time per **Run**, stores approval state in `agent.sqlite`, and parks the tool invocation with a `pi-durable` signal sleep until a decision arrives or the timeout expires. **Trigger** **Runs**, internal maintenance **Runs**, and non-TTY `wheatley ask` **Runs** auto-deny `ask` tools without prompting. An `allow_always` decision prepends an exact-tool `allow` rule through the Config Store and updates the live in-memory **Permission Policy** without restarting the **Agent**.

## Considered Options

- Prompt all parallel `ask` tool calls in one turn concurrently: rejected. Multiple simultaneous cards flood chat **Frontends** and duplicate prompts when the first decision grants `allow_conversation` or `allow_always`. Serializing one prompt at a time per **Run** lets subsequent matching calls re-evaluate policy and pass without a second prompt.
- Require an **Agent** restart before `allow_always` takes effect (strict ADR 0004): rejected. Restarting the **Agent** interrupts the active **Run** right after the user approves a tool. Updating the live in-memory policy alongside the Config Store write keeps the **Run** uninterrupted while preserving `config.yaml` as the durable source of truth.
- Pause **Trigger** **Runs** and wait for **Approval** in their target **Chat**: rejected. Unattended schedules and webhooks can stall for the full timeout window when nobody watches the **Chat**. Auto-denying `ask` tools in non-interactive **Runs** keeps unattended execution predictable and limits it to explicitly allowed tools.
- Abort the entire **Run** on `deny` or `timeout`: rejected. Returning a structured `{ isError: true }` tool result lets the model read the denial reason, adapt its plan, or explain the block to the **Sender**.

## Consequences

- `allow_always` is an explicit exception to ADR 0004: the **Agent** applies that single rule immediately in memory in addition to persisting it to `config.yaml`.
- An explicit `deny` rule in `config.yaml` always overrides any stored `allow_conversation` row in `agent.sqlite`.
- Unattended **Triggers** can only execute **Tools** allowed by the **Permission Policy**.
- Parked **Approvals** hold no in-memory invocation and release the Concurrency Gate model slot, so they survive daemon restarts cleanly.
