# AGENTS.md

Wheatley is a persistent personal TypeScript AI agent that replaces Hermes and OpenCloud for daily tasks.

## Runtime and compatibility

- Target **Node.js** `26.5.1` (`.node-version`), not Bun.
- Keep compatibility with third-party Node packages, native addons, and MCP servers.
- Consider `@earendil-works/pi-durable` if durable agent state is needed.

## Toolchain and code style

- Use `pnpm` (`12.23.0`) for all package commands.
- Write ESM TypeScript (`NodeNext` in `tsconfig.json`) with `strict` and `noUncheckedIndexedAccess` enabled.
- Follow `oxlint.config.ts`, which extends `ultracite/oxlint/core` and `ultracite/oxlint/anti-slop` with `typeAware: true`.
- Oxlint enforces `func-style` (expression). Write top-level functions as `export const fn = (...) => ...` instead of `function` declarations.
- Do not switch the linter back to Biome. Ultracite provides `anti-slop` for Oxlint only.

## Verification

1. Run `pnpm check` to verify `oxlint` and `oxfmt`.
2. Run `pnpm typecheck` to verify TypeScript types.
3. Run `pnpm build` to verify compilation to `dist/`.

`pnpm test` is a placeholder and fails until a test suite is added.

## CLI gotchas

- If a non-interactive shell defaults to an older Node.js version, run `eval "$(fnm env)" && fnm use` before `pnpm` commands.
- If a CLI tool (such as `ultracite init`) stalls on an open input stream, redirect standard input from `/dev/null`.
