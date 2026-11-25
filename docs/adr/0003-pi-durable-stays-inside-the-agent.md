# pi-durable stays inside the Agent

Only the Agent module imports `@earendil-works/pi-durable`, and inside it only `src/core/agent/pi-adapter.ts`. The CLI, the dashboard, Frontend Bindings, and the Deployment see Wheatley's own types and live events, such as `run.started`, `approval.requested`, and `approval.resolved`. pi-durable is experimental and changes its API between releases. Its live updates also do not include Approvals, delivery failures, or Agent health, so clients would need a second, Wheatley format anyway.

## Considered Options

- Forward pi-durable's live updates to the CLI and dashboard: rejected. A pi-durable upgrade could then break every client, and clients would still need Wheatley events for Approvals and delivery failures.

## Consequences

- The Agent reports a storage failure through `onFailed`. The Supervisor in the Deployment cannot see pi-durable errors.
- Extension types must not expose pi-durable types, or the Extension Catalog would import pi-durable.
