# Distribute through Node package managers, a `curl` installer, Homebrew, and AUR without SEA binaries

This decision supersedes ADR 0008. Wheatley still ships `@wheatley-ai/cli` as one npm package that runs on Node.js 26, and the `node:26-trixie-slim` Docker image with Docker Compose. Wheatley does not ship Node.js Single Executable Application (SEA) binaries. These channels deliver the same npm package:

- A global install with `npm`, `pnpm`, `yarn`, or `bun`.
- The `curl` installer `scripts/install.sh`.
- A Homebrew tap (`sphericalkat/tap/wheatley`).
- An AUR package (`wheatley-cli`).

The release workflow attaches `wheatley-ai-cli-<version>.tgz` to each GitHub release. Homebrew and AUR download that GitHub release asset instead of fetching the tarball from `registry.npmjs.org`.

The `curl` installer uses XDG folders and leaves `~/.wheatley` for the Deployment home:

- It installs the package with `npm` in `${XDG_DATA_HOME:-$HOME/.local/share}/wheatley/app`.
- It uses the host Node.js if its version is `26.13.1` or later.
- Otherwise, it downloads a pinned official Node.js 26 release into `${XDG_DATA_HOME:-$HOME/.local/share}/wheatley/runtime` and verifies the archive against `SHASUMS256.txt`.
- It writes the `wheatley` command to `${XDG_BIN_HOME:-$HOME/.local/bin}`. The command runs the resolved Node.js binary with `app/node_modules/@wheatley-ai/cli/bin/wheatley.js`.
- It accepts `--version <version>` and `--no-modify-path`. A rerun upgrades in place, so `wheatley update` can run it again for a curl install.

## Considered Options

- Ship Node.js 26 SEA binaries: rejected for the reasons in ADR 0008. SEA blocks external ESM `import()` of **Plugins** from the injected entry script, lacks an updater, and needs macOS code signing.
- Require a host Node.js 26 for every host install: rejected. Many systems ship an older Node.js, and a version manager is an extra step for users who only want Wheatley.
- Download Node.js into `~/.wheatley`: rejected. `~/.wheatley` holds the Deployment home (configuration and data), and XDG folders keep replaceable program files out of it.
- Support musl (Alpine Linux) in the `curl` installer: rejected. Node.js publishes no official musl builds. The installer stops with a message that recommends the system `nodejs` package or Docker.
- Download the CLI tarball from `registry.npmjs.org` in Homebrew and AUR: rejected. The npm registry can return `404` for several minutes after `npm publish` returns, which breaks automated release updates and couples Homebrew and AUR to npm availability.

## Consequences

- Every channel runs the same package on Node.js 26, so `node:sqlite` and external ESM **Plugins** work the same everywhere.
- The `curl` installer needs `curl` and `tar`. The downloaded Linux Node.js also needs `libatomic`.
- A pinned Node.js version in the installer changes only when the installer changes. A rerun keeps an existing runtime folder.
- `wheatley update` must detect each channel. It runs the upgrade command for `npm`, `pnpm`, `yarn`, `bun`, Homebrew, and the `curl` installer. It prints the command for channels that another tool manages (AUR, Docker, Volta, mise).
- CI runs the `curl` installer in a clean `debian:trixie-slim` container without Node.js and checks `wheatley --version`.
