# Dual-channel Frontend Binding delivery and explicit Chat commands

Each **Frontend Binding** receives outbound work through two channels: a required durable `deliver(Delivery)` method backed by the **Agent** outbox for final replies, **Trigger** outputs, and **Approval** lifecycle updates, and an optional `onEvent(event)` hook for ephemeral live **Run** progress such as typing indicators and streaming deltas. Each **Frontend Binding** also parses platform slash commands and calls a typed `sink.command` method instead of sending raw command text through `sink.send`.

## Considered Options

- Durable `deliver(Delivery)` only: rejected. Chat **Frontends** such as Telegram, Slack, and Discord cannot show typing indicators or stream draft replies during long **Runs**.
- Stream-first delivery for interactive **Runs**, with the outbox used only for **Triggers** and **Approvals**: rejected. Rate limits or brief disconnects drop final replies unless every **Frontend** adapter builds its own retry queue.
- Parse slash commands inside the **Agent** from raw `sink.send` text: rejected. User messages that happen to start with a slash become ambiguous, and native platform slash commands (Telegram menus, Discord slash commands) map more cleanly to a typed `sink.command` call.

## Consequences

- Minimal **Frontend** adapters omit `onEvent` and rely on `deliver(Delivery)` alone.
- Streaming **Frontend** adapters correlate ephemeral drafts with the final `message` delivery through `runId`.
- `FrontendSink` exposes the built-in command specs (`/new`, `/model`, `/compact`, `/stop`, `/goal`, `/status`, `/restart`) so adapters can register native command menus.
- Each **Frontend Binding** owns platform-specific message chunking and Markdown formatting, using an optional helper in `@wheatley/sdk`.
