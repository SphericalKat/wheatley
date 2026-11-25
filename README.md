# Wheatley

Wheatley is a persistent personal AI agent written in TypeScript for daily tasks.

## Prerequisites

- Node.js `26.5.1` (pinned in `.node-version`)
- `pnpm` `12.23.0`

## Setup

1. Install dependencies:

```bash
pnpm install
```

2. Build the project:

```bash
pnpm build
```

3. Run the entry point:

```bash
node dist/index.js
```

## Scripts

- `pnpm build`: Compile TypeScript from `src/` to `dist/`.
- `pnpm check`: Run lint and format checks.
- `pnpm fix`: Apply automatic lint and format fixes.
- `pnpm typecheck`: Run TypeScript type checks.
- `pnpm test`: Placeholder script that exits with code `1`.

## License

ISC
