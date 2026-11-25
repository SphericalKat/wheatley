# Store Triggers in Agent SQLite and verify webhooks with static Bearer tokens

Each **Agent** stores all **Trigger** definitions (`cron`, `once`, and `webhook`), schedule state (`next_fire_at`, `last_fired_at`, `paused`), pending webhook events, and the delivery outbox in its own `agent.sqlite` database rather than `config.yaml`. The **Webhook Ingress** verifies requests with a static Bearer token referenced by name from `secrets.yaml`, enforces a 256 KiB streaming body limit, persists accepted events to `agent.sqlite`, and returns `202 Accepted`.

## Considered Options

- Declare **Triggers** in `config.yaml` (or split static YAML **Triggers** and dynamic SQLite **Triggers**): rejected. ADR 0004 applies `config.yaml` edits by restarting the **Agent**, which breaks runtime reminder creation and pausing. Splitting **Triggers** across YAML and SQLite creates two sources of truth for one scheduler.
- Add a separate `interval` or heartbeat subsystem alongside `cron`: rejected. Standard 5-field `cron` expressions with an IANA timezone express fixed-cadence heartbeats without a second scheduler path.
- Support HMAC-SHA256 webhook verification in v1: rejected. Static Bearer tokens compared with `crypto.timingSafeEqual` cover personal automations with less per-provider signature configuration. HMAC-SHA256 can be added as a second verification mode later without breaking existing webhooks.

## Consequences

- Creating, editing, pausing, or deleting a **Trigger** takes effect immediately without restarting the **Agent**.
- Built-in **Agent** **Tools** (`schedule_trigger`, `list_triggers`, `cancel_trigger`, governed by the **Permission Policy**) manage `cron` and `once` **Triggers**, while only the **Operator** creates or edits `webhook` **Triggers** via the CLI or dashboard so an **Agent** cannot bind secrets from `secrets.yaml` or expose HTTP routes.
- Webhook secrets stay in `secrets.yaml` and never enter `agent.sqlite`.
- Providers that require HMAC-SHA256 signatures need a small proxy or a future Wheatley version.
