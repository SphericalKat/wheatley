# Release process

The `Release` workflow in `.github/workflows/release.yml` uses [release-please](https://github.com/googleapis/release-please). It runs on each push to `main`.

1. Write each commit title as a Conventional Commit, for example `feat: add a Trigger view` or `fix: close the socket`. release-please reads these titles to choose the next version and write `CHANGELOG.md`.
2. release-please opens or updates a release pull request. The pull request changes the version in the root `package.json`, `packages/wheatley/package.json`, and `packages/sdk/package.json`.
3. Merge the release pull request.
4. The workflow creates the `v<version>` tag and the GitHub release.
5. The `pack` job builds the workspace, packs `@wheatley-ai/sdk` and `@wheatley-ai/cli`, uploads `wheatley-ai-cli-<version>.tgz` to the GitHub release, outputs its SHA-256 checksum, and uploads the tarballs as a workflow artifact.
6. The `npm` job publishes `@wheatley-ai/sdk` and `@wheatley-ai/cli` to npm.
7. The `docker` job pushes the `linux/amd64` and `linux/arm64` image to `ghcr.io/sphericalkat/wheatley`.
8. The `aur` job updates `packaging/aur/PKGBUILD` and `.SRCINFO` for `wheatley-cli`, and the `homebrew` job renders `Formula/wheatley.rb` in `SphericalKat/homebrew-tap`, both using the GitHub release tarball and checksum.

Before version `1.0.0`, a `feat` commit raises the minor version, and a `fix` commit raises the patch version.

## Repository settings

The repository must have **Settings > Actions > General > Allow GitHub Actions to create and approve pull requests** turned on.

The workflow publishes to npm with [trusted publishing](https://docs.npmjs.com/trusted-publishers). It uses no npm token. Each npm package must have a trusted publisher with these values:

| Field                | Value          |
| -------------------- | -------------- |
| Organization or user | `SphericalKat` |
| Repository           | `wheatley`     |
| Workflow filename    | `release.yml`  |
| Environment          | (empty)        |

The AUR and Homebrew jobs need these repository settings:

| Setting | Kind | Value |
| --- | --- | --- |
| `AUR_SSH_PRIVATE_KEY` | Secret | The private SSH key of the AUR account |
| `AUR_USERNAME` | Variable | The AUR account name, for the commit and `Maintainer` |
| `AUR_EMAIL` | Variable | The email address for the commit and `Maintainer` |
| `HOMEBREW_TAP_TOKEN` | Secret | Token with write access to `SphericalKat/homebrew-tap` |

The CI copies of `PKGBUILD` and `.SRCINFO` replace the files in the AUR. The files in `packaging/aur` keep the version of the last manual edit.
