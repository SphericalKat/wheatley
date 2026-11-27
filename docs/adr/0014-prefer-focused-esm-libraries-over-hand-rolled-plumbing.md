# Prefer focused ESM libraries over hand-rolled plumbing

Wheatley adopts focused, well-maintained libraries for standard infrastructure instead of hand-rolling parsers, routers, and HTTP plumbing. Selected libraries must support Node.js 26 ESM and TypeScript without breaking Wheatley's existing seams (such as injectable `CliIo`, dual TCP and Unix socket listeners, and `ws` upgrade handling).

Wheatley standardizes on these libraries:

- **CLI parsing**: `commander` (`15.1.0`) for root and ops subcommands, global `--home`, scoped options, generated `--help`, and testable `CliIo` via `exitOverride()` and `configureOutput()`.
- **Markdown parsing**: `marked` (`18.3.0`) using `marked.lexer()` for both terminal TUI rendering and Telegram Bot API HTML rendering.
- **HTTP servers and static serving**: `hono` (`4.13.23`) and `@hono/node-server` (`2.1.11`) for the Control Server, dashboard static assets with SPA fallback, and **Webhook Ingress** (including early `413` body limits via `hono/body-limit`).
- **Semver comparison**: `semver` (`7.8.6`) for major-version-guarded update checks in `wheatley update`.
- **Dashboard routing**: `@tanstack/react-router` with code-based routes and browser history (`/agents/$agent/chat`), backed by the Control Server SPA fallback.

## Considered Options

Wheatley intentionally keeps four small custom modules instead of wrapping libraries that add risk or do not remove the custom logic:

- **TUI multiline editor (`editor.ts`, `prompt.tsx`)**: kept custom. No maintained `ink` 8 and React 19 library covers readline shortcuts, history recall, slash-command ghost text, and large-paste placeholders.
- **`SKILL.md` frontmatter fence split (`skill-file.ts`)**: kept custom. The module already parses YAML with `yaml` `2.9.1` and validates with TypeBox (matching `pi-mono`). Standalone libraries such as `gray-matter` and `front-matter` are unmaintained CommonJS packages that pull in `js-yaml` v3, and `gray-matter` enables an `eval()` JS engine by default.
- **Duration parsing (`protocol/duration.ts`)**: kept custom (35 lines). `ms` v2 is CommonJS (`v3` is beta) and accepts formats that Wheatley's `DurationSchema` rejects.
- **Daemon `LogStore` (`core/logger.ts`)**: kept custom (142 lines). `LogStore` owns the in-memory 2,000-record ring buffer for `logs.tail`, `log.record` WebSocket broadcasts, and secret-value redaction across third-party error messages. Adding `pino` (CommonJS, 11 dependencies) still requires `LogStore` as a custom stream consumer.

## Consequences

- New modules must prefer an existing focused ESM library before writing custom parsers, routers, or protocol plumbing.
- `packages/wheatley` adds `commander`, `marked`, `hono`, `@hono/node-server`, and `semver`, all with zero runtime transitive dependencies.
- `packages/dashboard` adds `@tanstack/react-router` and moves from hash URLs (`#/agents/...`) to browser history URLs (`/agents/...`).
- Research notes and primary-source citations live in `docs/research/library-replacements.md`.
