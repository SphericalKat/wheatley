# Bundled Plugins and bare-name resolution

Wheatley ships **Bundled Plugins** inside `@wheatley-ai/cli` as workspace packages under `packages/plugins/*`. Each **Bundled Plugin** imports no Wheatley package except `@wheatley-ai/sdk` and vendors into `@wheatley-ai/cli` at build time. When an **Agent** sets a bare `source` name in `config.yaml`, Wheatley checks the built-in registry before `~/.wheatley/extensions`.

## Considered Options

- Publish sample **Plugins** only as separate npm packages or unpublished `examples/` folders: rejected. **Operators** need useful **Plugins** ready to enable without extra installation steps.
- Use a reserved prefix such as `wheatley:web-search` or a scoped package name in `config.yaml`: rejected. Bare names keep `config.yaml` concise for **Operators**.
- Place **Bundled Plugins** inside `packages/wheatley/src/`: rejected. Separate workspace packages enforce that each **Bundled Plugin** depends only on `@wheatley-ai/sdk` and serves as a reference implementation.

## Consequences

- Each **Bundled Plugin** stays isolated from Wheatley internals and exercises the public `@wheatley-ai/sdk` contract.
- An npm package in `~/.wheatley/extensions` with the same bare name as a **Bundled Plugin** cannot shadow the **Bundled Plugin**.
- Any runtime dependency of a **Bundled Plugin** must also appear in `packages/wheatley/package.json` so the vendor step bundles it.
