# Ship v1 via npm/pnpm and Docker Compose without SEA binaries

Wheatley v1 distributes as a global `npm`/`pnpm` package (`wheatley`) and as a `node:26-trixie-slim` Docker image with Docker Compose. The repository uses a `pnpm` workspace monorepo with `packages/wheatley` (CLI, daemon, and bundled static dashboard assets), `packages/sdk` (`@wheatley-ai/sdk`), private `packages/protocol`, and private `packages/dashboard`. Wheatley v1 does not ship standalone Node.js Single Executable Application (SEA) binaries.

## Considered Options

- Ship Node.js 26 SEA binaries alongside `npm`/`pnpm` and Docker: rejected. Node.js 26 SEA blocks external filesystem `import()` from the injected entry script and rejects async ESM under `createRequire()`, which breaks dynamic ESM **Plugins** unless Wheatley ships a disk bootstrap shim. SEA also lacks a built-in updater, requires macOS code signing, and lacks CI support for macOS `x64` and Alpine Linux.
- Ship SEA binaries with MCP-only extensions (no external ESM **Plugins**): rejected. Splitting **Plugin** support across distribution targets complicates documentation, testing, and extension compatibility.
- Keep a single root `npm` package with subpath exports instead of a `pnpm` workspace: rejected. A workspace isolates `@wheatley-ai/sdk` with zero daemon dependencies, enforces the `protocol` seam between daemon, CLI, and dashboard, and gives the browser dashboard its own build configuration.

## Consequences

- Built-in `node:sqlite` and external ESM **Plugins** work identically on both global `npm`/`pnpm` installs and Docker Compose deployments.
- Host installs require Node.js 26 on the host machine and use `wheatley service` (`systemd --user` or `launchd`) for background operation.
- Upgrades delegate to `npm`/`pnpm` (optionally through `wheatley update`) or `docker compose pull && docker compose up -d`.
- Standalone single-file binaries stay out of scope for v1 and require a new decision if Node.js SEA lifts its external ESM `import()` restrictions.
