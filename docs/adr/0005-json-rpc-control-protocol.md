# JSON-RPC over WebSocket for the CLI and dashboard

The CLI and the dashboard talk to the daemon through one protocol: JSON-RPC 2.0 over a WebSocket. The daemon serves this protocol on a local Unix socket and on a localhost port. Commands, chat input, live events, and Approvals share one ordered connection, so a client never receives the events of a Run before the reply to the command that started it. An Approval is a broadcast event, not a request to one client. The first `decide` call wins, and every client then receives `approval.resolved`.

## Considered Options

- HTTP for commands plus a WebSocket for events: rejected, because events can arrive before the HTTP response that caused them.
- HTTP plus Server-Sent Events: rejected for the same ordering problem, and because the stream is one-way.
- Approvals as server-to-client JSON-RPC requests: rejected, because Telegram, the CLI, and several dashboard tabs can answer the same Approval.

## Consequences

- A one-shot CLI command opens a WebSocket for one request.
- Webhooks never use this protocol. The Webhook Ingress has its own listener and token check, because the control protocol has no login (ADR 0002).
