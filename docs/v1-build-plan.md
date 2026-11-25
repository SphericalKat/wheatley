# Wheatley v1 Vertical-Slice Build Plan

This document defines the sequenced build plan for Wheatley v1. It translates [GLOSSARY.md](../GLOSSARY.md) and ADRs `0001` through `0012` into three dependency waves optimized for maximum agent parallelism.

## Architecture References

- Glossary: [GLOSSARY.md](../GLOSSARY.md)
- Wayfinder map: [Wheatley v1 architecture and vertical-slice build plan](https://github.com/SphericalKat/wheatley/issues/7)
- Architecture decisions:
  - `docs/adr/0001-harness-per-agent.md`
  - `docs/adr/0002-no-identity-or-access-control.md`
  - `docs/adr/0003-pi-durable-stays-inside-the-agent.md`
  - `docs/adr/0004-yaml-config-file-and-agent-restart.md`
  - `docs/adr/0005-json-rpc-control-protocol.md`
  - `docs/adr/0006-in-process-plugins-inline-per-agent.md`
  - `docs/adr/0007-frontend-binding-dual-delivery-and-commands.md`
  - `docs/adr/0008-npm-and-docker-distribution-without-sea.md`
  - `docs/adr/0009-markdown-memory-with-derived-fts5-index.md`
  - `docs/adr/0010-triggers-in-sqlite-and-static-bearer-webhooks.md`
  - `docs/adr/0011-durable-serialized-approvals-and-live-policy-allow.md`
  - `docs/adr/0012-chat-frontends-transport-allowlist-and-threads.md`

## Dependency Waves

```text
Wave 0 (serial, 1 track)
  └── 0-contracts-workspace
        │
        ├── Wave 1 (parallel, 12 isolated tracks)
        │     ├── 1-core-runtime
        │     ├── 1-approvals
        │     ├── 1-memory
        │     ├── 1-plugins
        │     ├── 1-mcp
        │     ├── 1-skills
        │     ├── 1-triggers
        │     ├── 1-frontend-telegram
        │     ├── 1-frontend-slack
        │     ├── 1-frontend-discord
        │     ├── 1-dashboard
        │     └── 1-ops-packaging
        │
        └── Wave 2 (serial, blocked by all 12 Wave 1 tracks)
              └── 2-integration-release
```

## Verification Gate

Every track in Wave 0, Wave 1, and Wave 2 must pass all four checks before merge:

1. `pnpm check`
2. `pnpm typecheck`
3. `pnpm build`
4. `pnpm test`

Vitest is the standard test runner across all Node packages and `packages/dashboard`. Every test must target public module interfaces and use in-memory fakes at external seams.

## Parallel Isolation Rules for Wave 1

Wave 1 tracks run concurrently across separate branches and pull requests. Follow these rules to prevent merge conflicts:

- Edit only files inside the track's owned directory and its own tests.
- Export a module factory, SQLite migration list, and JSON-RPC handler map from the track's entry module.
- Do not modify shared wiring files (`Deployment`, `Agent`, CLI root command, or top-level JSON-RPC router) during Wave 1.
- Do not modify frozen contracts in `packages/protocol` or `packages/sdk` during Wave 1 unless a Wave 0 follow-up PR merges first.
- Add third-party runtime dependencies only to the package that owns the track.

## Wave 0: Workspace and Frozen Contracts

### Track `0-contracts-workspace`

- **Owned paths**: Root workspace config (`pnpm-workspace.yaml`, root `package.json`, `tsconfig.base.json`, `vitest.config.ts`), `packages/protocol/`, `packages/sdk/`, `packages/wheatley/src/contracts/`, `packages/wheatley/src/db/`, `packages/dashboard/` (empty workspace package stub).
- **Depends on**: None.
- **Scope**:
  - Convert the repository to a `pnpm` workspace with `packages/wheatley`, `packages/protocol` (private), `packages/sdk` (`@wheatley-ai/sdk`), and `packages/dashboard` (private).
  - Configure Vitest across the workspace and verify `pnpm check`, `pnpm typecheck`, `pnpm build`, and `pnpm test`.
  - Define the complete v1 JSON-RPC envelope, method schemas, and event payloads in `packages/protocol` (ADR 0005, dashboard, approvals, memory, triggers, config, secrets, logs).
  - Define `@wheatley-ai/sdk` (`apiVersion: 1`) in `packages/sdk`: `Plugin`, `Tool` (plain JSON Schema and Standard JSON Schema), `FrontendBinding`, `Delivery` (`message`, `approval_requested`, `approval_resolved`), `FrontendContext` (including `registerWebhookRoute`), `Attachment`, and `FrontendSink` with zero `@earendil-works/pi-durable` types (ADRs 0003, 0006, 0007, 0011, 0012).
  - Implement the `node:sqlite` migration runner seam for `agent.sqlite` with per-module migration namespaces.
  - Define internal TypeScript module interfaces and in-memory test fakes under `packages/wheatley/src/contracts/` for `ConfigStore`, `ApprovalGate`, `MemoryStore`, `ExtensionCatalog`, `TriggerRuntime`, `DeliveryOutbox`, and `WebhookIngress`.
  - Add a `@earendil-works/pi-durable` (`1.6.1`) type and smoke test to confirm harness creation, signal sleep, and compaction hooks against the real package.
- **Acceptance criteria**:
  - All workspace packages build, lint, typecheck, and run Vitest.
  - `@wheatley-ai/sdk` exports zero `pi-durable` types.
  - The `pi-durable` smoke test passes in Node.js `26.5.1`.

## Wave 1: Isolated Feature Tracks (12 Parallel Tracks)

Every Wave 1 track is blocked only by `0-contracts-workspace`.

### Track `1-core-runtime`

- **Owned paths**: `packages/wheatley/src/core/`, `packages/wheatley/src/cli/`, `packages/wheatley/src/tools/`.
- **ADRs**: `0001`, `0002`, `0003`, `0004`, `0005`, `0007`.
- **Scope**:
  - Implement `ConfigStore` for `config.yaml` and `secrets.yaml` with comment-preserving YAML AST patching, `expectedRevision` checks, pending-restart detection, and secret redaction.
  - Implement `Deployment`, `Supervisor`, and `ConcurrencyGate` for isolated multi-Agent lifecycle management (start, stop, restart, degraded isolation, Agent create/rename/delete).
  - Implement `Agent` wrapping `@earendil-works/pi-durable` (`harness.sqlite` per Agent) as the sole module that imports `pi-durable`.
  - Implement the localhost HTTP and JSON-RPC WebSocket server (`/ws`) with browser `Origin` validation and event broadcast.
  - Implement CLI commands (`init`, `daemon`, `chat`, `ask`, `status`) with one fixed CLI `Chat` (`default`) per `Agent` and built-in slash commands (`/new`, `/model`, `/compact`, `/stop`, `/goal`, `/status`, `/restart`).
  - Implement built-in `Tools`: `read_file`, `write_file`, and `shell`.
- **Acceptance criteria**:
  - Contract tests prove two isolated `Agents` run in one `Deployment` with separate `harness.sqlite` files and enforced `ConcurrencyGate` limits.
  - CLI `chat` and `ask` complete a `Run` against an in-memory fake LLM provider and execute `read_file`, `write_file`, and `shell`.

### Track `1-approvals`

- **Owned paths**: `packages/wheatley/src/approvals/`.
- **ADRs**: `0002`, `0011`.
- **Scope**:
  - Implement `ApprovalGate` and ordered `permissionPolicy` evaluation (first match wins, canonical tool `*` wildcards only, built-in defaults or `ask` fallback, explicit `deny` overrides `allow_conversation`).
  - Persist pending `Approvals` and `allow_conversation` grants (cleared on `/new`) in `agent.sqlite`.
  - Serialize `ask` calls one at a time per `Run` and park via `pi-durable` signal sleep (default `15m` timeout, `null` disables timeout).
  - Support `allow_once`, `allow_conversation`, `allow_always` (prepend to `ConfigStore` plus immediate live policy update), and `deny` (optional reason).
  - Return `{ isError: true }` to the model on `deny` and `timeout`, emit `cancelled` on `/stop`, and auto-deny `ask` tools in Trigger, maintenance, and non-TTY `wheatley ask` Runs.
  - Build secret-redacted 500-character `inputPreview` payloads with `expiresAt` and an interactive CLI prompt renderer.
- **Acceptance criteria**:
  - Contract tests cover policy precedence, serialized `ask` parking, all four decisions, timeout, `/stop` cancellation, `allow_always` live update, and auto-deny contexts.

### Track `1-memory`

- **Owned paths**: `packages/wheatley/src/memory/`.
- **ADRs**: `0009`.
- **Scope**:
  - Manage Markdown files under `~/.wheatley/agents/<name>/memory/` (`MEMORY.md` with default 4,000-character cap rejecting oversized writes, plus `<slug>.md`).
  - Maintain a derived `node:sqlite` FTS5 index and user/assistant `Conversation` archive in `agent.sqlite`, rebuildable from Markdown.
  - Implement built-in memory `Tools`: `memory_search`, `memory_read`, `memory_write`, and `memory_delete` (default `allow`).
  - Provide frozen `MEMORY.md` snapshot injection at `Conversation` start and after `/compact`, a silent pre-compaction flush hook, and a default-on scheduled consolidation job.
  - Export Operator JSON-RPC handlers for memory inspection, edits, and archive purges.
- **Acceptance criteria**:
  - Contract tests verify Markdown source-of-truth writes, 4,000-character rejection, FTS5 search, rebuild from disk, snapshot freeze until `/compact`, and archive purge.

### Track `1-plugins`

- **Owned paths**: `packages/wheatley/src/plugins/`.
- **ADRs**: `0006`.
- **Scope**:
  - Implement the in-process `Plugin` loader from explicit inline per-Agent configuration (local paths or npm packages in `~/.wheatley/extensions/`).
  - Validate integer `apiVersion: 1` and accept plain JSON Schema or Standard JSON Schema for `Tool` parameters.
  - Namespace plugin `Tools` as `<plugin>:<tool>` and collect plugin-contributed `Frontends`.
  - Isolate plugin load failures so a broken `Plugin` skips loading and surfaces diagnostics without blocking `Agent` startup.
- **Acceptance criteria**:
  - Contract tests load valid local and package plugins, reject mismatched `apiVersion`, verify `<plugin>:<tool>` naming, and prove load failures do not block startup.

### Track `1-mcp`

- **Owned paths**: `packages/wheatley/src/mcp/`.
- **ADRs**: `0006`.
- **Scope**:
  - Implement the `MCP Server` client manager using `@modelcontextprotocol/client` v2 (`2.4.0`) with `versionNegotiation: { mode: 'auto' }`.
  - Support stdio and Streamable HTTP transports, Tools only, and static secrets resolved from `secrets.yaml`.
  - Namespace discovered tools as `mcp:<server>:<tool>` and expose them through the `Tool` seam under `Permission Policy`.
  - Isolate connection failures per `MCP Server` and manage clean shutdown on `Agent` stop.
- **Acceptance criteria**:
  - Contract tests connect to mock stdio and Streamable HTTP MCP servers, verify `mcp:<server>:<tool>` naming and tool invocation, and prove server failures stay isolated.

### Track `1-skills`

- **Owned paths**: `packages/wheatley/src/skills/`.
- **ADRs**: `0006`.
- **Scope**:
  - Auto-discover `Skills` from `~/.wheatley/skills/` and `~/.wheatley/agents/<name>/skills/` (Agent directory overrides shared directory on collision).
  - Implement 3-tier `SKILL.md` progressive disclosure (frontmatter catalog, full `SKILL.md` body load, optional bundled reference files).
  - Ensure `Permission Policy` always overrides `allowed-tools` metadata in `SKILL.md`.
- **Acceptance criteria**:
  - Contract tests verify discovery precedence, 3-tier disclosure, invalid `SKILL.md` skipping, and `Permission Policy` enforcement over `allowed-tools`.

### Track `1-triggers`

- **Owned paths**: `packages/wheatley/src/triggers/`.
- **ADRs**: `0010`.
- **Scope**:
  - Store `cron` (with timezone), `once`, and `webhook` `Triggers`, schedule state, pending webhook events, and the FIFO `DeliveryOutbox` in `agent.sqlite` (hot-managed without `Agent` restart).
  - Implement scheduling semantics: overdue `once` catches up once; missed and overlapping `cron` ticks skip; default to a new `Conversation` per firing; support `suppress_delivery`.
  - Implement `DeliveryOutbox`: fail immediately on permanent errors (for example, deleted `Chat`), retry retryable errors with exponential backoff up to 10 attempts or 24 hours, emit `delivery.failed`, and copy results into the target `Chat` `Conversation` only on confirmed delivery.
  - Implement the `WebhookIngress` HTTP server supporting `POST /webhooks/<agent>/<trigger-id>` (static Bearer token from `secrets.yaml`, 256 KiB streaming cap returning `413`, persist-then-`202 Accepted`, `503` when `Agent` is stopped or degraded) and dynamic `/frontends/<agent>/<binding-id>/...` routes.
  - Implement Agent `Tools` for `cron` and `once` management (under `Permission Policy`) and Operator JSON-RPC handlers for all `Triggers` (including `webhook`) and outbox retry or dismiss actions.
- **Acceptance criteria**:
  - Contract tests verify `cron` timezone and overlap skipping, `once` catch-up, outbox retry and copy-on-confirm, `401`/`413`/`503`/`202` webhook responses, and frontend webhook route mounting.

### Track `1-frontend-telegram`

- **Owned paths**: `packages/wheatley/src/frontends/telegram/`.
- **ADRs**: `0007`, `0012`.
- **Scope**:
  - Implement the built-in Telegram `FrontendBinding` using lazy dynamic import of `grammy`.
  - Support outbound polling by default and optional webhook mode via `FrontendContext.registerWebhookRoute(...)` with adapter-verified secret token.
  - Enforce non-empty `allowedChatIds`, map DMs, groups, and forum topics (`<chat_id>:topic:<thread_id>`) to separate `Chats`, and default to mention-or-reply in groups.
  - Implement typing plus ~1.2s throttled draft edits (configurable to typing-only), 10 MiB staged inbound and outbound attachments, 4-button `Approvals` with edit-on-resolve, and native `setMyCommands` registration.
- **Acceptance criteria**:
  - Contract tests against a mocked `grammy` client verify allowlist enforcement, forum-topic `Chat` keys, mention gating, draft edit throttling, attachments, 4-button `Approval` callbacks, and webhook token verification.

### Track `1-frontend-slack`

- **Owned paths**: `packages/wheatley/src/frontends/slack/`.
- **ADRs**: `0007`, `0012`.
- **Scope**:
  - Implement the built-in Slack `FrontendBinding` using lazy dynamic imports of `@slack/web-api` and `@slack/socket-mode`.
  - Support Socket Mode by default and optional Events API webhook mode via `FrontendContext.registerWebhookRoute(...)` with Slack signing-secret verification.
  - Enforce non-empty `allowedChatIds`, map DMs, channels, and threads (`<channel_id>:<thread_ts>`) to separate `Chats`, and default to mention-or-reply in channels.
  - Implement typing plus ~1.2s throttled message edits (configurable to typing-only), 10 MiB staged inbound and outbound attachments, 4-button Block Kit `Approvals` with update-on-resolve, and Slash Command manifest handling.
- **Acceptance criteria**:
  - Contract tests against mocked Slack clients verify allowlist enforcement, thread `Chat` keys, signature verification, throttled edits, attachments, and Block Kit `Approval` callbacks.

### Track `1-frontend-discord`

- **Owned paths**: `packages/wheatley/src/frontends/discord/`.
- **ADRs**: `0007`, `0012`.
- **Scope**:
  - Implement the built-in Discord `FrontendBinding` using lazy dynamic import of `discord.js`.
  - Enforce non-empty `allowedChatIds`, map DMs, channels, and threads (`<thread_id>`) to separate `Chats`, and default to mention-or-reply in guild channels.
  - Implement typing plus ~1.2s throttled message edits (configurable to typing-only), 10 MiB staged inbound and outbound attachments, 4-button component `Approvals` with disable-on-resolve, and native Slash Commands registration.
- **Acceptance criteria**:
  - Contract tests against a mocked `discord.js` client verify allowlist enforcement, thread `Chat` keys, mention gating, throttled edits, attachments, 4-button `Approval` interactions, and Slash Commands.

### Track `1-dashboard`

- **Owned paths**: `packages/dashboard/`.
- **ADRs**: `0004`, `0005`.
- **Scope**:
  - Build the React + Vite + Tailwind CSS + UI SDK (`ui-sdk.dev`) SPA against `packages/protocol` JSON-RPC schemas and a mock WebSocket fixture server.
  - Implement the Hermes-inspired sidebar with a global `Agent` switcher and Deployment-wide views: Overview and Health, Logs, Secrets (masked list plus on-demand `secrets.reveal`), and Inbox (Pending `Approvals` with Approve/Deny and Failed Deliveries with Retry/Dismiss).
  - Implement per-Agent views: `Chat` (sharing the CLI `default` `Chat`), live and persisted `Runs` with Stop, `Memory` controls, `Triggers` and Extensions, and Config (structured forms plus raw YAML editor with `expectedRevision` conflict handling, pending-restart indicators, Save / Save & Restart, and confirmed Agent create/rename/delete).
- **Acceptance criteria**:
  - Vite production build emits static assets ready for bundling into `packages/wheatley`.
  - Vitest tests cover JSON-RPC client state, Inbox approval and retry flows, `secrets.reveal`, and `expectedRevision` conflict handling against the mock WebSocket server.

### Track `1-ops-packaging`

- **Owned paths**: `packages/wheatley/src/ops/`, `docker/`, packaging scripts in `packages/wheatley/`.
- **ADRs**: `0008`.
- **Scope**:
  - Implement `wheatley service` to install, start, stop, restart, and inspect `systemd --user` and `launchd` units with a 30-second drain and 45-second stop grace period.
  - Implement `wheatley update` to delegate updates to `npm` or `pnpm` within the current major version (or print Docker Compose update commands) with no background auto-updates.
  - Implement pre-migration `VACUUM INTO` backups (retaining the last 5 per Agent), per-Agent `degraded` state reporting on migration failure, and `wheatley restore <agent> <backup>`.
  - Add `Dockerfile` and `docker-compose.yml` based on `node:26-trixie-slim` and wire npm packaging (`bin` entry and bundled dashboard assets).
- **Acceptance criteria**:
  - Contract tests verify `systemd` and `launchd` unit generation, backup rotation (5 retained), `VACUUM INTO` backup and restore round-trip, and `wheatley update` major-version guard.

## Wave 2: Integration and v1 Release Gate

### Track `2-integration-release`

- **Owned paths**: Shared wiring in `packages/wheatley/src/` (`Deployment`, `Agent`, CLI root, JSON-RPC router, localhost HTTP server serving `/` dashboard and `/ws`), end-to-end test suite under `packages/wheatley/test/e2e/`.
- **Depends on**: All 12 Wave 1 tracks.
- **Scope**:
  - Wire all 12 Wave 1 modules into `Deployment`, `Agent`, `ConfigStore`, CLI root commands, JSON-RPC router, and `WebhookIngress`.
  - Bundle `packages/dashboard` static build output into `packages/wheatley` and serve it on `/` alongside `/ws` on one localhost HTTP server with `Origin` validation.
  - Verify cross-slice end-to-end flows with a real `@earendil-works/pi-durable` harness and a fake LLM provider:
    1. Multi-Agent `Deployment` isolation (`harness.sqlite` and `agent.sqlite` per Agent).
    2. CLI `chat` and `ask` with `read_file`, `write_file`, `shell`, and serialized `Approval` prompts (`allow_once`, `allow_conversation`, `allow_always`, `deny`, timeout).
    3. `Memory` write, FTS5 search, frozen snapshot injection, and `/compact` refresh.
    4. `Plugin`, `MCP Server`, and `Skill` loading with `Permission Policy` enforcement.
    5. `Trigger` firing and `WebhookIngress` -> `DeliveryOutbox` -> `FrontendBinding` delivery and copy-on-confirm.
    6. Live Dashboard SPA served by the daemon over `/ws` (Approvals Inbox, Config Save & Restart, Agent CRUD).
    7. Pre-migration `VACUUM INTO` backup, migration, `wheatley restore`, and `node:26-trixie-slim` Docker image build.
- **Acceptance criteria**:
  - All workspace checks (`pnpm check`, `pnpm typecheck`, `pnpm build`, `pnpm test`) and the full Wave 2 E2E suite pass.
  - `npm pack` produces a clean installable tarball containing compiled `dist/` and bundled dashboard assets.
