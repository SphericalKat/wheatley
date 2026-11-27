import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";

import { API_VERSION } from "@wheatley-ai/sdk";
import type { Plugin } from "@wheatley-ai/sdk";
import { resolve as resolveModule } from "import-meta-resolve";

import { RESERVED_PLUGIN_NAME } from "../contracts/tool-names.js";
import { hasApiVersion, hasDefaultExport, isPlugin } from "./guards.js";
import { compileSchema } from "./schema.js";
import type { CompiledSchema } from "./schema.js";

const PLUGIN_NAME = /^[a-z][a-z0-9_-]*$/u;
const HOME_PREFIX = "~/";
const RELATIVE_PREFIXES = ["./", "../"] as const;

/** The folder of the Deployment home that holds npm Plugin packages in its `node_modules/`. */
export const EXTENSIONS_DIR = "extensions";

/** A Plugin module's default export after validation. */
export interface PluginDefinition {
  readonly plugin: Plugin<unknown>;
  readonly configSchema: CompiledSchema | undefined;
}

const isLocalPath = (source: string): boolean =>
  path.isAbsolute(source) ||
  source.startsWith(HOME_PREFIX) ||
  RELATIVE_PREFIXES.some((prefix) => source.startsWith(prefix));

/**
 * The Bundled Plugins (ADR 0015): bare `source` names that resolve to a workspace package that ships with Wheatley.
 * The build vendors each package into `dist/node_modules/`.
 */
const BUNDLED_PLUGINS: ReadonlyMap<string, string> = new Map([
  ["web-search", "@wheatley-ai/plugin-web-search"],
]);

/**
 * Resolves a Plugin `source` from `config.yaml` to the specifier that `import()` loads.
 *
 * - The name of a Bundled Plugin, for example `web-search`, loads the package that ships with Wheatley. An npm package
 *   of the same name in `<homeDir>/extensions/` does not shadow it.
 * - An absolute path loads as is.
 * - A path that starts with `~/` resolves against the user's home directory.
 * - A path that starts with `./` or `../` resolves against `homeDir`.
 * - Any other source is an npm package specifier, for example `wheatley-plugin-notes` or `@acme/wheatley-notes`. It
 *   resolves with the Node ESM algorithm from `<homeDir>/extensions/`, so it finds packages in
 *   `<homeDir>/extensions/node_modules/` and honors their `exports` field.
 *
 * Errors: throws if an npm package does not resolve, for example because it is not installed.
 */
export const resolvePluginSpecifier = (
  source: string,
  homeDir: string
): string => {
  const bundled = BUNDLED_PLUGINS.get(source);

  // `import()` resolves the bare package name from this module, which finds the vendored copy.
  if (bundled !== undefined) {
    return bundled;
  }

  if (!isLocalPath(source)) {
    const parent = `${pathToFileURL(path.join(homeDir, EXTENSIONS_DIR)).href}/`;

    return resolveModule(source, parent);
  }

  const file = source.startsWith(HOME_PREFIX)
    ? path.join(homedir(), source.slice(HOME_PREFIX.length))
    : path.resolve(homeDir, source);

  return pathToFileURL(file).href;
};

/**
 * Resolves and imports one Plugin module, then validates its default export against the `Plugin` contract of
 * `@wheatley-ai/sdk`.
 *
 * Node caches modules by URL, so two Agents that list the same `source` share the module. Each Agent calls `setup`
 * separately, so they share no Plugin instance (ADR 0006).
 *
 * Errors: rejects with a message for Agent health if the source does not resolve, the module throws on import, the
 * module has no default export, `apiVersion` is not the integer `1`, the export breaks the `Plugin` contract, the name
 * breaks `^[a-z][a-z0-9_-]*$` or is `mcp`, or `configSchema` does not compile.
 */
export const importPlugin = async (
  source: string,
  homeDir: string
): Promise<PluginDefinition> => {
  const module: unknown = await import(resolvePluginSpecifier(source, homeDir));

  if (!hasDefaultExport(module)) {
    throw new TypeError("The module has no default export");
  }

  const exported = module.default;

  if (!hasApiVersion(exported)) {
    throw new TypeError("The default export declares no apiVersion");
  }

  if (exported.apiVersion !== API_VERSION) {
    throw new TypeError(
      `The Plugin declares apiVersion ${inspect(exported.apiVersion)}, but Wheatley supports only apiVersion ${API_VERSION}`
    );
  }

  if (!isPlugin(exported)) {
    throw new TypeError(
      "The default export breaks the Plugin contract: it needs name and version strings, a setup function, and an optional configSchema of plain JSON Schema or Standard JSON Schema"
    );
  }

  if (
    !PLUGIN_NAME.test(exported.name) ||
    exported.name === RESERVED_PLUGIN_NAME
  ) {
    throw new TypeError(
      `Invalid Plugin name ${inspect(exported.name)}: it must match ${PLUGIN_NAME.source} and must not be ${RESERVED_PLUGIN_NAME}`
    );
  }

  return {
    configSchema:
      exported.configSchema === undefined
        ? undefined
        : compileSchema(exported.configSchema),
    plugin: exported,
  };
};
