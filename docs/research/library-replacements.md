# Library Replacements for Hand-Rolled Wheatley Code

This report evaluates npm packages to replace nine hand-rolled subsystems in Wheatley (`@wheatley-ai/cli`, `@wheatley-ai/protocol`, and `@wheatley-ai/dashboard`). All findings target Node.js `>=26.13.1`, TypeScript `^7.0.2` with `NodeNext` ESM, `ink` `8.0.0`, `react` `19.3.1`, and `vite` `8.3.8`. All package metadata reflects npm registry responses on 2026-11-27.

## Summary of Recommendations

| Area | Current Files | Recommendation | Runtime Deps |
| --- | --- | --- | --- |
| CLI framework | `src/cli/main.ts`, `src/ops/cli.ts` | `commander` `15.1.0` | 0 |
| Markdown parser | `src/cli/tui/markdown.ts`, `src/frontends/telegram/markdown.ts` | `marked` `18.3.0` | 0 |
| HTTP framework | `src/core/server/control-server.ts`, `static-files.ts`, `src/triggers/webhook-ingress.ts` | `hono` `4.13.23` + `@hono/node-server` `2.1.11` | 0 |
| Semver | `src/ops/update.ts` | `semver` `7.8.6` + `@types/semver` `7.8.0` | 0 |
| Ink multiline editor | `src/cli/tui/editor.ts`, `src/cli/tui/prompt.tsx` | Keep custom editor | 0 |
| Frontmatter | `packages/wheatley/src/skills/skill-file.ts` | Keep `yaml` `parseDocument` + `---` fence regex | 0 (already uses `yaml`) |
| Duration parsing | `packages/protocol/src/duration.ts` | Keep custom `parseDuration` | 0 |
| Dashboard router | `packages/dashboard/src/router.ts`, `src/views/app.tsx` | Keep custom router (or `wouter` `3.13.0` if routing grows) | 0 (or 2 for `wouter`) |
| Structured logger | `packages/wheatley/src/core/logger.ts`, `src/cli/daemon.ts` | Keep custom `LogStore` | 0 |

---

## 1. CLI Framework

### Wheatley Requirements

- Parse global `--home <dir>` before or after any subcommand (`wheatley --home /dir status` and `wheatley status --home /dir`).
- Support per-subcommand options, positional arguments, and per-subcommand `--help` across `init`, `daemon`, `chat`, `ask`, `status`, `service`, `update`, and `restore`.
- Unify `src/cli/main.ts` and `src/ops/cli.ts` so `main.ts` removes the manual `takeHomeOption` pre-pass.
- Inject `CliIo` (`stdout`, `stderr`, `env`) in tests without calls to `process.exit()`, `process.stdout.write()`, or `process.stderr.write()`.

### Candidate Comparison

| Package | Version | ESM | Bundled TS Types | Deps | Global Options Before/After | Injectable I/O Without `process.exit` |
| --- | --- | --- | --- | --- | --- | --- |
| `commander` | `15.1.0` | Yes (`"type": "module"`) | Yes (`typings/index.d.ts`) | 0 | Yes (default mode + `optsWithGlobals()`) | Yes (`exitOverride()` + `configureOutput()`) |
| `@stricli/core` | `1.3.0` | Yes (`"type": "module"`) | Yes (`dist/index.d.ts`) | 0 | No (route-first scanner, global flags are integration-only) | Yes (`runApplication` + `StricliProcess`) |
| `citty` | `0.2.2` | Yes (`"type": "module"`) | Yes (`dist/index.d.mts`) | 0 | Partial (subcommand-scoped args) | No (`runMain` calls `process.exit` and `console.log`/`error`) |
| `cac` | `7.1.1` | Yes (`"type": "module"`) | No (`types: null`, missing in `exports`) | 0 | Yes | No (writes help/version to `console.log`) |

### Analysis

- **`commander` (`15.1.0`)**: Requires Node `>=22.12.0` and ships zero dependencies with native ESM and bundled types ([npm metadata](https://registry.npmjs.org/commander/latest), [GitHub repository](https://github.com/tj/commander.js)).
  - In default mode (without `enablePositionalOptions()`), root options such as `--home <dir>` parse before or after subcommands, and subcommands read them via `command.optsWithGlobals()` ([Commander README](https://github.com/tj/commander.js#readme)).
  - `program.exitOverride()` replaces `process.exit()` with a thrown `CommanderError` that carries `exitCode` and `code` ([Commander README](https://github.com/tj/commander.js#readme)).
  - `program.configureOutput({ writeOut, writeErr, outputError })` routes all help, version, and error text into Wheatley's `CliIo` callbacks ([Commander README](https://github.com/tj/commander.js#readme)).
- **`@stricli/core` (`1.3.0`)**: Ships zero dependencies with native ESM and TypeScript ([npm metadata](https://registry.npmjs.org/@stricli%2Fcore/latest)). `runApplication(app, rawInputs, context)` returns `Promise<number>` and writes only to `context.process.stdout` and `context.process.stderr` ([`run.ts`](https://github.com/bloomberg/stricli/blob/main/packages/core/src/application/run.ts), [`context.ts`](https://github.com/bloomberg/stricli/blob/main/packages/core/src/context.ts)). However, its route scanner resolves route names before command flags, and global flags (`AdditionalFlag.global`) are restricted to integrations ([`scanner.ts`](https://github.com/bloomberg/stricli/blob/main/packages/core/src/routing/scanner.ts)). Accepting `--home` before a subcommand requires manual pre-stripping.
- **`citty` (`0.2.2`)**: Pre-1.0 with zero dependencies ([npm metadata](https://registry.npmjs.org/citty/latest)). Its `runMain()` calls `process.exit(0)` on `--help`, `console.log()` on `--version`, and `console.error()` plus `process.exit(1)` on failure ([`src/main.ts`](https://github.com/unjs/citty/blob/main/src/main.ts)).
- **`cac` (`7.1.1`)**: Published with `"types": null` and `"exports": { ".": "./dist/index.js" }`, which omits TypeScript declarations under `NodeNext` ([npm metadata](https://registry.npmjs.org/cac/latest), [`package.json`](https://github.com/cacjs/cac/blob/main/package.json)). Help and version output also print via `console.log()`.

### Recommendation

Adopt **`commander` (`15.1.0`)**. Wrap each CLI invocation in a fresh `new Command()` configured with `exitOverride()` and `configureOutput()`, then map `CommanderError.exitCode` (returning `2` for usage errors to match existing contracts) to the resolved exit code of `runCli`.

---

## 2. Markdown Parser

### Wheatley Requirements

- **TUI ANSI renderer (`src/cli/tui/markdown.ts`)**: Streams LLM replies line by line via `createMarkdownRenderer()`, tracks code-fence state across lines, and outputs `MarkdownLine` (`lead`, `body`, `hang`) so `wrap-ansi` preserves hanging indents.
- **Telegram HTML renderer (`src/frontends/telegram/markdown.ts`)**: Converts complete Markdown replies to the Telegram Bot API HTML subset (`<b>`, `<i>`, `<s>`, `<code>`, `<pre><code class="language-...">`, `<a href="...">`, `<blockquote>`) with matched tags and full HTML escaping.

### Candidate Comparison

| Package | Version | ESM | Bundled TS Types | Deps | Token Model |
| --- | --- | --- | --- | --- | --- |
| `marked` | `18.3.0` | Yes (`"type": "module"`) | Yes (`lib/marked.d.ts`) | 0 | Nested AST (`TokensList`, `Token`, `Lexer.lexInline`) |
| `markdown-it` | `15.0.3` | Dual ESM/CJS (`exports`) | Yes (`dist/markdown-it.d.mts`) | 6 | Flat open/close token stream (`md.parse`, `md.parseInline`) |

### Analysis

- **`marked` (`18.3.0`)**: Requires Node `>=20`, ships zero dependencies, native ESM, and bundled TypeScript types ([npm metadata](https://registry.npmjs.org/marked/latest), [Marked documentation](https://marked.js.org)).
  - `new Marked()` isolates configuration per renderer without global mutation ([Marked extensibility docs](https://marked.js.org/using_pro)).
  - `Lexer.lex(markdown)` produces a nested AST of typed block and inline tokens, and `Lexer.lexInline(text)` tokenizes a single line of inline Markdown without block wrappers ([Marked API docs](https://marked.js.org/using_pro)).
  - **Telegram HTML**: Walking `marked`'s nested AST or supplying a custom `Renderer` maps each token directly to Telegram's allowed HTML tags while escaping raw HTML tokens (`html` token rendered as escaped text) and guaranteeing balanced tags.
  - **TUI streaming**: Markdown block parsing is inherently multi-line, so neither `marked` nor `markdown-it` streams arbitrary partial lines natively. Keep the small line-level fence tracker in `createMarkdownRenderer()` for streamed lines, and replace the regex + `U+E000` placeholder logic in `renderInline()` with `marked.Lexer.lexInline()` so nested emphasis, escaped characters, and backtick counts parse according to CommonMark/GFM rules.
- **`markdown-it` (`15.0.3`)**: Ships bundled `.d.mts` types in v15 (no `@types/markdown-it` needed), but adds 6 runtime dependencies (`mdurl`, `argparse`, `entities`, `uc.micro`, `linkify-it`, `punycode.js`) ([npm metadata](https://registry.npmjs.org/markdown-it/latest), [GitHub repository](https://github.com/markdown-it/markdown-it)). Its flat `*_open` / `*_close` token stream requires manual stack tracking when building `MarkdownLine` structures or suppressing unsupported nested HTML tags for Telegram.

### Recommendation

Adopt **`marked` (`18.3.0`)**. Use an isolated `Marked` instance with a custom Telegram HTML renderer for `src/frontends/telegram/markdown.ts`, and use `Lexer.lexInline()` inside `src/cli/tui/markdown.ts` while keeping the thin line-oriented fence tracker for streamed `MarkdownLine` output.

---

## 3. HTTP Framework

### Wheatley Requirements

- **Control Server (`src/core/server/control-server.ts`)**: Listen on both a loopback TCP port and an owner-only Unix domain socket (`chmod 0o600`). Attach `ws` `WebSocketServer({ noServer: true })` to the underlying `node:http` `Server` `upgrade` event with `Origin` validation (`403` on foreign origin) on TCP only.
- **Static dashboard (`src/core/server/static-files.ts`)**: Serve `GET` and `HEAD` from `staticDir` with MIME types, `x-content-type-options: nosniff`, `cache-control` (`no-cache` for `index.html`, `max-age=3600` for assets), path-traversal protection, and SPA fallback to `index.html` for extensionless paths. Fall back to a plain-text `/` note when `staticDir` is absent.
- **Webhook ingress (`src/triggers/webhook-ingress.ts`)**: Enforce a 256 KiB streaming body limit that returns `413` early on both `Content-Length` and chunked streams without buffering the full payload, plus `requestTimeout = 30_000`.

### Candidate Comparison

| Feature | `hono` `4.13.23` + `@hono/node-server` `2.1.11` | `fastify` `5.12.8` + `@fastify/static` `11.0.0` |
| --- | --- | --- |
| Module format | Native ESM (`"type": "module"`) | CommonJS (`"type": "commonjs"`) |
| Bundled TS types | Yes | Yes |
| Direct dependencies | 0 + 0 | 15 + 7 |
| Dual TCP + Unix socket | Clean: two `createAdaptorServer({ fetch: app.fetch })` servers share one `Hono` app | Awkward: one listener per Fastify instance, needs two instances or custom `serverFactory` |
| `ws` `noServer: true` `upgrade` | Native: `createAdaptorServer` returns `node:http.Server` for `.on("upgrade")` | Native: `fastify.server.on("upgrade")` |
| Static + SPA fallback | `@hono/node-server/serve-static` + extensionless fallback route | `@fastify/static` (`reply.sendFile("index.html")` in `setNotFoundHandler`) |
| Streaming 256 KiB `413` | `hono/body-limit` checks `Content-Length` and aborts chunked reader early | Built-in `bodyLimit: 262144` aborts stream with `413` (`FST_ERR_CTP_BODY_TOO_LARGE`) |

### Analysis

- **`hono` (`4.13.23`) + `@hono/node-server` (`2.1.11`)**: Both packages ship zero dependencies, native ESM, and bundled TypeScript types ([`hono` npm](https://registry.npmjs.org/hono/latest), [`@hono/node-server` npm](https://registry.npmjs.org/@hono%2Fnode-server/latest)).
  - **Dual listeners and `ws` upgrade**: `createAdaptorServer({ fetch: app.fetch })` returns a standard `node:http.Server` ([`src/server.ts`](https://github.com/honojs/node-server/blob/main/src/server.ts)). `ControlServer` can call `createAdaptorServer` twice: once for TCP (`tcp.listen(port, host)`) and once for the Unix socket (`unix.listen(socketPath)` followed by `chmod(socketPath, 0o600)`). It then attaches the existing `upgrade` handler with per-listener `checkOrigin` directly to each `Server`.
  - **Static files and SPA fallback**: `@hono/node-server/serve-static` handles `GET`/`HEAD`, MIME detection via `hono/utils/mime`, path traversal rejection, and `onFound` hooks where Wheatley can set `cache-control` and `x-content-type-options: nosniff` ([`src/serve-static.ts`](https://github.com/honojs/node-server/blob/main/src/serve-static.ts)). Adding a fallback `GET` route for paths without an extension serves `index.html` for SPA routing, and omitting static routes when `staticDir` is `undefined` preserves the plain-text `/` response.
  - **Streaming 256 KiB `413`**: `hono/body-limit` checks `Content-Length` immediately when `Transfer-Encoding` is absent, and reads chunked bodies with `c.req.raw.body.getReader()`, returning `onError(c)` (`413`) as soon as `size > maxSize` ([`src/middleware/body-limit/index.ts`](https://github.com/honojs/hono/blob/main/src/middleware/body-limit/index.ts)). Note one behavioral detail: `bodyLimit` returns a `413` `Response` without setting `connection: close` or destroying the raw Node socket. Set `connection: close` in `onError` and set `server.requestTimeout = 30_000` on the `Server` returned by `createAdaptorServer`.
- **`fastify` (`5.12.8`) + `@fastify/static` (`11.0.0`)**: Supports `fastify.listen({ path })`, `fastify.server.on("upgrade")`, `bodyLimit`, and `@fastify/static` ([Fastify server docs](https://fastify.dev/docs/latest/Reference/Server/), [`@fastify/static` repository](https://github.com/fastify/fastify-static)). However, Fastify adds 22 direct dependencies (`pino`, `ajv`, `avvio`, `glob`, and others), ships as CommonJS, and binds one listener per instance ([`fastify` npm](https://registry.npmjs.org/fastify/latest), [`@fastify/static` npm](https://registry.npmjs.org/@fastify%2Fstatic/latest)).

### Recommendation

Adopt **`hono` (`4.13.23`) + `@hono/node-server` (`2.1.11`)**. Use `createAdaptorServer` so `ControlServer` and `HttpWebhookIngress` keep full control over TCP/Unix listeners, `chmod 0o600`, `requestTimeout`, and raw `ws` `upgrade` events while replacing manual routing, MIME tables, and static file handling.

---

## 4. Semver

### Wheatley Requirements

Replace `parseVersion`, `compareVersions`, and `newest` in `src/ops/update.ts` (lines 23–101), which validate semantic versions, exclude prereleases, filter by `major`, check `version > installed`, and select the highest release.

### API Verification (`semver` `7.8.6` + `@types/semver` `7.8.0`)

`semver` (`7.8.6`) ships zero runtime dependencies under the ISC license, and `@types/semver` (`7.8.0`) ships zero dependencies under MIT ([`semver` npm](https://registry.npmjs.org/semver/latest), [`@types/semver` npm](https://registry.npmjs.org/@types%2Fsemver/latest), [`npm/node-semver` repository](https://github.com/npm/node-semver)).

| Current Helper in `update.ts` | `semver` Replacement | Notes |
| --- | --- | --- |
| `parseVersion(text)` | `semver.valid(text)` | Returns normalized string or `null`. Caveat: `semver.valid("v1.2.3")` returns `"1.2.3"`. If strict exact matching without leading `v` or `=` is required, check `semver.valid(text) === text` (or `semver.parse(text)` with `version.raw === version.version`). |
| `version.prerelease` | `semver.prerelease(text) !== null` | Returns array of prerelease identifiers, or `null` for stable releases. |
| `version.major` | `semver.major(text)` | Returns the numeric major version. |
| `compareVersions(v, installed) > 0` | `semver.gt(v, installed)` | Follows SemVer 2.0.0 precedence. Stable releases sort after prereleases of the same version. |
| `newest(versions)` | `versions.toSorted(semver.rcompare)[0]` | `rcompare` sorts descending (newest first). |

Under TypeScript `NodeNext`, `semver` is CommonJS (`"type": null`), so import it with the default import (`import semver from "semver"`).

### Recommendation

Adopt **`semver` (`7.8.6`)** and **`@types/semver` (`7.8.0`)** in `src/ops/update.ts`.

---

## 5. Ink v8 + React 19 Multiline Editor

### Wheatley Requirements

`src/cli/tui/editor.ts` (192 lines) and `src/cli/tui/prompt.tsx` provide:

- Multiline editing with vertical cursor movement that preserves column position.
- Readline shortcuts (`Ctrl+W`, `Ctrl+U`, `Ctrl+K`, word left/right, `Home`/`End`).
- History recall on `Up`/`Down` when the cursor is on the first or last line, with unsent-draft preservation.
- Ink v8 `usePaste` integration with collapsed placeholders (`[Pasted text #N · M lines]`) for large pastes.
- Slash-command autocomplete menu with inline ghost completion and double-press `Esc`/`Ctrl+C` guards.

### Ecosystem Survey

| Package | Version | Last Published | Weekly Downloads | Peer Dependencies | Gaps for Wheatley |
| --- | --- | --- | --- | --- | --- |
| `@inkjs/ui` | `2.0.0` | 2024-05-22 | — | `ink >=5` | Single-line `<TextInput>` only ([npm](https://registry.npmjs.org/@inkjs%2Fui/latest)). |
| `ink-text-input` | `6.0.0` | 2024-05-14 | — | `ink >=5`, `react >=18` | Single-line only ([npm](https://registry.npmjs.org/ink-text-input/latest)). |
| `react-ink-textarea` | `0.4.0` | 2026-08-07 | 1,740 | `ink ^7.0.0`, `react ^18 \|\| ^19` | Peer range excludes `ink` `8.0.0`. No built-in paste placeholders or history ([npm](https://registry.npmjs.org/react-ink-textarea/latest), [GitHub](https://github.com/omranjamal/react-ink-textarea)). |
| `ink-multiline-input` | `0.1.0` | 2026-01-03 | 2,896 | `ink >=6`, `react >=19` | Early `0.1.0` release. Lacks readline word/line shortcuts, history, ghost text, and Ink `usePaste` placeholder handling ([npm](https://registry.npmjs.org/ink-multiline-input/latest), [GitHub](https://github.com/ByteLandTechnology/ink-multiline-input)). |

### Recommendation

**Keep Wheatley's custom `editor.ts` and `prompt.tsx`.** No maintained Ink multiline component matches `ink` `8.0.0` + `react` `19.3.1` while covering Wheatley's readline shortcuts, history recall, slash-command ghost text, and `usePaste` placeholder tokens. Wheatley's `editor.ts` is 192 lines of pure functions with zero external dependencies and low maintenance cost.

---

## 6. Frontmatter Parsing

### Wheatley Requirements

`packages/wheatley/src/skills/skill-file.ts` (150 lines) parses `SKILL.md` files:

- Strip an optional leading UTF-8 BOM (`\uFEFF`).
- Require strict `---` opening and closing fences at the start of the file.
- Parse YAML safely without executing embedded code, and return structured `ok: false` reasons on invalid YAML without throwing.
- Validate keys against TypeBox `FrontmatterSchema` (`name`, `description`, optional `allowed-tools`) while allowing unknown keys (`license`, `metadata`).

`skill-file.ts` already delegates YAML parsing to `yaml` (`2.9.1`, `parseDocument`), which is already a direct dependency of `@wheatley-ai/cli`. The only custom extraction code is two lines: stripping the BOM and matching `/^---[ \t]*\r?\n(?:(?<yaml>[\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/u`.

### Candidate Comparison

| Package | Version | Last Modified | Module Format | Bundled TS Types | Deps | Key Caveats |
| --- | --- | --- | --- | --- | --- | --- |
| `gray-matter` | `4.0.3` | 2023-07-12 | CommonJS | No | 4 (`js-yaml ^3.13.1`, `kind-of`, `section-matter`, `strip-bom-string`) | Unmaintained upstream; bundles legacy `js-yaml` v3; default `js`/`javascript` engine calls `eval()` on `---js` blocks. |
| `@11ty/gray-matter` | `3.0.0` | 2026-07-29 | CommonJS | No | 2 (`js-yaml ^5.2.2`, `section-matter`) | Maintained fork that updates `js-yaml`, but still CJS without bundled types and adds a second YAML parser. |
| `front-matter` | `4.0.2` | 2023-07-12 | CommonJS | No (no `@types/front-matter`) | 1 (`js-yaml ^3.13.1`) | Unmaintained upstream; bundles legacy `js-yaml` v3; no TypeScript declarations on npm. |
| `yaml` (current) | `2.9.1` | 2026-09-11 | Dual (`exports`) | Yes (`dist/index.d.ts`) | 0 | Already installed; `parseDocument()` exposes `document.errors` cleanly without throwing. |

### Analysis

- **`gray-matter` (`4.0.3`)**: Unmaintained since 2023 ([npm metadata](https://registry.npmjs.org/gray-matter/latest), [GitHub repository](https://github.com/jonschlinkert/gray-matter)). Its default JavaScript engine evaluates `---js` and `---javascript` frontmatter via `eval()`, creating an RCE vector on untrusted `SKILL.md` files unless custom engines override the default. It also pulls in `js-yaml` `^3.13.1`, which is superseded and incompatible with `js-yaml` v4/v5 overrides.
- **`front-matter` (`4.0.2`)**: Unmaintained since 2023, depends on `js-yaml` `^3.13.1`, ships as CommonJS, and has neither bundled types nor an `@types/front-matter` package ([npm metadata](https://registry.npmjs.org/front-matter/latest)).
- **`yaml` (`2.9.1`)**: Already a direct dependency of `@wheatley-ai/cli` with zero runtime dependencies and bundled TypeScript types ([npm metadata](https://registry.npmjs.org/yaml/latest)). Keeping `parseDocument()` plus the two-line BOM and `---` fence check avoids a second YAML parser and keeps full control over error messages.

### Recommendation

**Keep the current `yaml` `parseDocument` + `---` fence regex in `packages/wheatley/src/skills/skill-file.ts`.** Replacing two lines of fence extraction with `gray-matter` or `front-matter` would add unmaintained CommonJS packages, legacy `js-yaml` v3, and (for `gray-matter`) an `eval()` risk without removing any validation code.

---

## 7. Duration Parsing

### Wheatley Requirements

- `packages/protocol/src/domain.ts` defines `DurationSchema` as `Type.String({ pattern: "^[0-9]+(ms|s|m|h|d)$" })`, used by `DaemonConfigSchema.drainTimeout` and `AgentConfigSchema.approvalTimeout` in `packages/protocol/src/config.ts`.
- `packages/protocol/src/duration.ts` (35 lines) converts matched strings to milliseconds and throws `RangeError` for non-matching text or values exceeding `Number.MAX_SAFE_INTEGER`.
- `@wheatley-ai/protocol` is shared between Node.js (`@wheatley-ai/cli`) and the browser (`@wheatley-ai/dashboard`), so it must stay ESM-clean and lightweight.

### Candidate Evaluation (`ms`)

| Package / Tag | Version | Last Modified | Module Format | Bundled TS Types | Deps |
| --- | --- | --- | --- | --- | --- |
| `ms` (`latest`) | `2.1.3` | 2025-09-08 | CommonJS | No (`@types/ms` `2.1.0`) | 0 |
| `ms` (`beta`) | `3.0.0-beta.2` | 2025-09-08 | Native ESM + CJS (`exports`) | Yes (`lib/index.d.ts`) | 0 |

- **`ms` (`2.1.3` / `3.0.0-beta.2`)**: `ms` `v2` is CommonJS and requires `@types/ms`; `v3` adds native ESM, bundled template-literal types (`StringValue`), and `parseStrict`, but remains on the `beta` dist-tag ([`ms` npm](https://registry.npmjs.org/ms/latest), [`vercel/ms` repository](https://github.com/vercel/ms)).
- **Strictness mismatch**: `ms` accepts formats that `DurationSchema` explicitly rejects, including spaces and long/plural units (`"2 days"`, `"1 year"`, `"2 weeks"`), decimals (`"1.5h"`, `".5d"`), negative numbers (`"-3 days"`, `"-100"`), bare numeric strings (`"100"`), and uppercase units (`"1D"`). In v2, invalid strings return `undefined` instead of throwing `RangeError`, and `ms` does not enforce `Number.isSafeInteger` overflow checks.
- **Net code savings**: Adopting `ms` would still require running Wheatley's `^[0-9]+(ms|s|m|h|d)$` regex and `Number.isSafeInteger` guard so `parseDuration` stays consistent with `DurationSchema`. That leaves `ms` to replace only a 5-entry multiplier object (`ms`, `s`, `m`, `h`, `d`).

### Recommendation

**Keep `packages/protocol/src/duration.ts`.** At 35 lines with zero dependencies, it matches `DurationSchema` exactly, enforces `Number.isSafeInteger`, throws `RangeError` deterministically, and avoids adding a CommonJS or beta dependency to `@wheatley-ai/protocol`.

---

## 8. Dashboard Router

### Wheatley Requirements

- `packages/dashboard/src/router.ts` (60 lines) and `packages/dashboard/src/views/app.tsx` (17 lines for `useRoute`/`navigate`) route 4 deployment views (`overview`, `inbox`, `logs`, `secrets`) and 5 per-agent views (`chat`, `runs`, `memory`, `triggers`, `config`) via hash URLs (`#/agents/<name>/<view>`, with `#/agents/<name>` defaulting to `chat` and unknown hashes falling back to `overview`).
- Target `react` `19.3.1`, `react-dom` `19.3.1`, `vite` `8.3.8`, and Vitest unit tests (`packages/dashboard/src/router.test.ts`).
- `ControlServer` already serves `index.html` as an SPA fallback for extensionless paths, so browser History API paths (`/agents/<name>/<view>`) are supported without server changes, while hash routing remains safe for static hosting and existing links.

### Candidate Comparison

| Package | Version | Module Format | Bundled TS Types | Deps | React 19 Peer | Unpacked Size | Hash & Test Routing |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `wouter` | `3.13.0` | Native ESM | Yes (`types/index.d.ts`) | 2 (`regexparam`, `use-sync-external-store`) | Yes (`>=16.8.0`) | 80 kB (~2.2–2.6 kB gzipped) | `wouter/use-hash-location`, `wouter/use-browser-location`, `wouter/memory-location` |
| `react-router` (`latest` / `version-7`) | `8.5.3` / `7.18.7` | Native ESM | Yes | 2 (`cookie-es`, `@remix-run/route-pattern` in v8) | Yes (`>=19.2.7` in v8; `>=18` in v7) | 3.0 MB (v8) / 4.8 MB (v7) | `HashRouter`, `BrowserRouter`, `MemoryRouter` (Library/Declarative mode) |
| `@tanstack/react-router` | `1.170.46` | Dual ESM/CJS | Yes | 4 (`@tanstack/history`, `@tanstack/react-store`, `@tanstack/router-core`, `isbot`) | Yes (`>=18 \|\| >=19`) | 1.07 MB | `createHashHistory`, `createBrowserHistory`, `createMemoryHistory` |

### Analysis

- **`wouter` (`3.13.0`)**: Minimal hook-based router with native ESM, bundled TypeScript types, and React 19 compatibility ([npm metadata](https://registry.npmjs.org/wouter/latest), [GitHub repository](https://github.com/molefrog/wouter)). Its subpath exports provide `useHashLocation` for hash URLs, `useBrowserLocation` for History API URLs backed by `ControlServer`'s SPA fallback, and `memoryLocation` for Vitest tests without DOM location hacks.
- **`react-router` (`8.5.3` / `7.18.7`)**: Library/Declarative mode (`HashRouter`, `BrowserRouter`, `MemoryRouter`, `Routes`, `Route`) works inside a standalone Vite SPA without adopting Framework Mode ([npm metadata](https://registry.npmjs.org/react-router/latest), [React Router modes docs](https://reactrouter.com/start/modes)). However, its package footprint (3.0–4.8 MB unpacked) is disproportionate for 9 flat views with no loaders or nested outlets.
- **`@tanstack/react-router` (`1.170.46`)**: Offers strong static route typing and built-in hash/memory history ([npm metadata](https://registry.npmjs.org/@tanstack%2Freact-router/latest), [TanStack Router repository](https://github.com/TanStack/router)). Because Wheatley's dashboard loads all data through WebSocket RPC stores in `ServicesContext` rather than route loaders, TanStack Router's route-tree setup and 4 runtime dependencies add unnecessary complexity.

### Recommendation

**Keep the current 60-line `router.ts` for now; adopt `wouter` (`3.13.0`) if the dashboard adds nested routes, query parameters, or `<Link>`/`<Switch>` navigation.** The existing discriminated-union `Route` type and `useSyncExternalStore` hook have zero dependencies and trivial Vitest coverage (`router.test.ts`). When routing requirements expand beyond 9 flat views, `wouter` provides the smallest, cleanest upgrade path with built-in hash, browser-history, and Vitest memory-location support.

---

## 9. Structured Logger

### Wheatley Requirements

`packages/wheatley/src/core/logger.ts` (142 lines) and `packages/wheatley/src/cli/daemon.ts` combine five responsibilities in `LogStore`:

1. Create scoped `Logger` objects tagged with `module` and optional `agent`.
2. Stamp each `LogRecord` with a monotonic `seq` number and an ISO timestamp from an injected `Clock` (`clock.now()`).
3. **Value-based secret redaction**: pass every `message` and serialized `fields` object through `redact: (text: string) => string`, replacing known secret values anywhere they appear regardless of key name.
4. Retain the latest 2,000 records (`LOG_BUFFER_SIZE`) in memory and serve filtered queries via `LogStore.tail(filter)` (`agent`, `module`, `level`, `limit`).
5. Emit each record as a `log.record` event to `EventSink` and invoke an optional `write(record)` callback (`daemon.ts` writes `${JSON.stringify(record)}\n` to `io.stderr` via `CliIo`).

### Candidate Evaluation (`pino`)

| Package | Version | Last Modified | Module Format | Bundled TS Types | Deps | Unpacked Size |
| --- | --- | --- | --- | --- | --- | --- |
| `pino` | `10.4.0` | 2026-10-02 | CommonJS (`"type": "commonjs"`) | Yes (`pino.d.ts`) | 11 | 706 kB |

- **Integration mechanics**: `pino` accepts a custom `DestinationStream` (`{ write(chunk: string): void }`) and `hooks.logMethod` ([npm metadata](https://registry.npmjs.org/pino/latest), [Pino API docs](https://getpino.io/#/docs/api)). A custom destination could forward output to `io.stderr` and feed `LogStore`.
- **Critical caveat — key-path vs. value redaction**: `pino.redact` (`@pinojs/redact`) redacts **known JSON key paths** (for example `req.headers.authorization` or `*.token`), not arbitrary secret value substrings ([Pino redaction docs](https://getpino.io/#/docs/redaction)). It cannot scrub a secret value that leaks into a free-text error `message` or an arbitrary tool output field. Wheatley would still need its own `redact(text)` pass on messages and serialized fields.
- **Schema and dependency overhead**: Pino defaults to numeric levels (`20`/`30`/`40`/`50`), `msg`, `time`, `pid`, and `hostname`. Preserving Wheatley's `LogRecord` schema (`seq`, deterministic `Clock` `at`, string `level`, `message`, `module`, `agent`, `fields`), 2,000-record ring buffer, and `EventSink` emission would require custom formatters and parsing Pino's JSON output back into `LogRecord` objects inside a custom destination stream, while adding 11 runtime dependencies (`sonic-boom`, `thread-stream`, `@pinojs/redact`, `pino-std-serializers`, `safe-stable-stringify`, and 6 others).

### Recommendation

**Keep `LogStore` in `packages/wheatley/src/core/logger.ts`.** `LogStore` is an in-process domain store (value-based secret scrubber, deterministic-clock ring buffer for `logs.tail`, and `EventSink` publisher) rather than a high-throughput file logger. Adopting `pino` (`10.4.0`) would not remove any of `LogStore`'s core logic and would add 11 CommonJS dependencies plus redundant JSON serialization/parsing. Revisit `pino` only if Wheatley later requires log file rotation, worker-thread transports, or high-volume HTTP access logs.
