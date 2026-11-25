# Chat Frontends use outbound-first transports, mandatory Chat allowlists, and thread-scoped Chat IDs

Built-in Telegram, Slack, and Discord **Frontends** ship inside `packages/wheatley` behind lazy dynamic imports (`grammy`, `@slack/web-api` with `@slack/socket-mode`, and `discord.js`). Each **Frontend Binding** uses an outbound connection by default (Telegram long polling, Slack Socket Mode, Discord Gateway) and optionally mounts webhook endpoints on the existing Webhook Ingress HTTP server through `FrontendContext.registerWebhookRoute(...)` at `POST /frontends/<agent>/<binding-id>/<pathSuffix>`. Every chat **Frontend Binding** requires a non-empty `allowedChatIds` list in `config.yaml` and maps each DM, group or channel, Telegram forum topic (`<chat_id>:topic:<thread_id>`), Slack thread (`<channel_id>:<thread_ts>`), and Discord thread (`<thread_id>`) to its own **Chat**.

## Considered Options

- Outbound-only connections in v1 with no webhook mode: rejected. Operators who already terminate HTTPS behind a reverse proxy need standard Telegram and Slack webhooks without waiting for v2. Mounting **Frontend** webhook routes on the existing Webhook Ingress server keeps the Control Server localhost-only and avoids a second HTTP listener per **Frontend Binding**.
- Optional `allowedChatIds` allowlist with open DMs by default: rejected. Telegram bots are publicly discoverable by username, and Wheatley has no user accounts or access control (ADR 0002). Requiring an explicit `allowedChatIds` list on every chat **Frontend Binding** enforces access gating at the **Frontend** seam from day one.
- Map an entire Slack channel or Telegram forum to one shared **Chat**: rejected. Concurrent topics in one channel collide inside a single **Conversation**. Thread-scoped and topic-scoped `chatId` values isolate each **Conversation** while allowlist checks still match the parent channel or group ID.
- Add an in-message `!cmd` fallback on Slack instead of native Slash Commands: rejected. Declaring all seven built-in commands in the Slack App manifest keeps command syntax uniform across Telegram, Slack, and Discord.

## Consequences

- Each **Frontend** adapter verifies its own webhook requests (Telegram secret token header, Slack HMAC-SHA256 signature and timestamp) and fails startup validation if webhook mode is enabled while Webhook Ingress is disabled.
- Unlisted **Chats** are dropped silently on the platform and logged at `info` level with their `chatId` so the **Operator** can discover IDs during setup.
- Live `onEvent` output uses a typing indicator plus throttled draft-edit streaming (default 1.2s interval, finalized on `deliver` via `runId`), with a per-binding option for typing-only mode.
- Persisted `chatId` values in `agent.sqlite` and **Trigger** targets encode platform thread structure and remain stable within a major version.
