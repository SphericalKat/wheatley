# AGENTS.md

Wheatley is a persistent personal TypeScript AI agent that replaces Hermes and OpenCloud for daily tasks.

## Runtime and compatibility

- Target **Node.js** `26.5.1` (`.node-version`), not Bun.
- Keep compatibility with third-party Node packages, native addons, and MCP servers.
- If the project needs durable agent state, consider `@earendil-works/pi-durable`.

## Toolchain and entry point

- Use `pnpm` (`12.23.0`) for all package commands.
- Use TypeScript (`^7.0.2`) with ESM (`NodeNext` in `tsconfig.json`), `strict`, and `noUncheckedIndexedAccess`.
- Keep the entry point in `src/index.ts` and compile to `dist/index.js`.
- Follow `oxlint.config.ts`, which extends `ultracite/oxlint/core` and `ultracite/oxlint/anti-slop` with `typeAware: true` (`ultracite` `8.3.1`).
- Do not switch the linter back to Biome. Ultracite provides `anti-slop` for Oxlint only.

## Verification

1. Run `pnpm check` to run Oxlint and `oxfmt` checks.
2. Run `pnpm fix` to apply automatic Oxlint and `oxfmt` fixes.
3. Run `pnpm typecheck` to check TypeScript types.
4. Run `pnpm build` to compile `src/` to `dist/`.

Until you add a test suite, `pnpm test` fails as a placeholder.

## CLI gotchas

- If a non-interactive shell defaults to an older Node.js version, run `eval "$(fnm env)" && fnm use` before `pnpm` commands.
- If a CLI tool (such as `ultracite init`) stalls on an open input stream, redirect standard input from `/dev/null`.

## Ultracite code standards

Ultracite (`oxlint` and `oxfmt`) enforces most format and lint rules automatically. Follow these project rules when you write TypeScript code.

### Type safety and explicitness

- Use explicit types for function parameters and return values when they clarify intent.
- Prefer `unknown` over `any` when a type is genuinely unknown.
- Use `as const` for immutable values and literal types.
- Use TypeScript type narrowing instead of type assertions.
- Extract magic numbers into constants with descriptive names.

### Modern JavaScript and TypeScript

- Write top-level functions as arrow functions assigned to `const` (`export const fn = (...) => ...`), and define them above where you call them.
- Prefer `for...of` loops over `.forEach()` and indexed `for` loops.
- Use optional chaining (`?.`) and nullish coalescing (`??`) for property access.
- Prefer template literals over string concatenation.
- Use destructuring for object and array assignments.
- Use `const` by default, `let` only when reassignment is needed, and never `var`.

### Async and promises

- Always `await` promises in async functions and use the return value.
- Use `async`/`await` syntax instead of promise chains.
- Handle errors in async code with `try`/`catch` blocks.
- Do not use async functions as `Promise` executors.

### Error handle and debug rules

- Remove `console.log`, `debugger`, and `alert` statements from production code unless the module intentionally writes CLI output.
- Throw `Error` objects with descriptive messages instead of strings or other values.
- Use `try`/`catch` blocks only when you handle or enrich the error.
- Prefer early returns over nested conditionals for error cases.

### Code organization and performance

- Keep functions focused and under reasonable complexity limits.
- Extract complex conditions into named boolean variables.
- Put braces around every `if` body, including one-line guards.
- Use a single ternary for two outcomes. Use early returns or a lookup for three or more outcomes.
- Avoid import cycles by moving shared code into a separate module.
- Do not leave `TODO` or `FIXME` comments in new code.
- Do not use `eval()`. Validate and sanitize untrusted input.
- Avoid spread syntax in accumulators inside loops.
- Define regex literals at module scope instead of inside loops.
- Avoid barrel files (`index.ts` files that only re-export other modules) inside the app.

### Tests

- Write assertions inside `it()` or `test()` blocks.
- Use `async`/`await` in async tests instead of `done` callbacks.
- Do not commit `.only` or `.skip` in tests.
- Keep test suites flat and avoid deep `describe` levels.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `SphericalKat/wheatley` via `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the five default triage labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (`GLOSSARY.md` and `docs/adr/` at the repo root). See `docs/agents/domain.md`.
