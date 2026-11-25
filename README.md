# Wheatley

Wheatley is a persistent personal AI agent written in TypeScript. It replaces Hermes and OpenCloud for daily tasks.

## Architecture and stack

The project targets Node.js instead of Bun for maximum compatibility with third-party SDKs, native addons, and MCP servers. It may use `@earendil-works/pi-durable` for durable execution.

- **Runtime**: Node.js `26.5.1` (pinned in `.node-version`)
- **Package manager**: `pnpm` `12.23.0`
- **Language**: TypeScript `^7.0.2` with ESM (`NodeNext`) and `noUncheckedIndexedAccess`
- **Lint and format**: Ultracite `8.3.1` with Oxlint (`core` and `anti-slop` presets, type-aware) and `oxfmt`

## Current status

The repository contains the initial project scaffold. [src/index.ts](src/index.ts) exports and runs `main`, which logs `"Wheatley initialized."`. No test runner is configured yet.

## Prerequisites

Install Node.js `26.5.1` via `fnm` and enable `pnpm` `12.23.0`.

## Setup

1. Install dependencies:

```bash
pnpm install
```

2. Build the project:

```bash
pnpm build
```

3. Run the compiled entry point:

```bash
node dist/index.js
```

## Scripts

- `pnpm build`: Compile TypeScript from `src/` to `dist/`.
- `pnpm check`: Run Ultracite (`oxlint` and `oxfmt` checks).
- `pnpm fix`: Apply Ultracite automatic fixes.
- `pnpm typecheck`: Run `tsc --noEmit`.
- `pnpm test`: Placeholder script that exits with code `1`.
