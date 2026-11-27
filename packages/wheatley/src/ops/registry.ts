import { Type } from "typebox";
import { Value } from "typebox/value";

import { envValue } from "./paths.js";

/** The npm package name of the daemon and CLI. */
export const PACKAGE_NAME = "@wheatley-ai/cli";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";

/** The abbreviated packument has only the fields that installs need, which keeps the response small. */
const ABBREVIATED_PACKUMENT = "application/vnd.npm.install-v1+json";

const REGISTRY_TIMEOUT_MS = 10_000;

const TRAILING_SLASHES = /\/+$/u;

/** The subset of `fetch` that the registry query uses. Tests replace it at this network boundary. */
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

const PackumentSchema = Type.Object({
  versions: Type.Record(Type.String(), Type.Unknown()),
});

export interface RegistryOptions {
  /** Reads `npm_config_registry`, which overrides `https://registry.npmjs.org`. */
  readonly env: NodeJS.ProcessEnv;
  readonly fetch: FetchFn;
}

/**
 * Lists the published versions of `@wheatley-ai/cli` with one HTTP request to the npm registry. It does not start a
 * package manager, so the `devEngines` field of a `package.json` in the working folder cannot make it fail.
 *
 * Errors: rejects on a network error, a timeout after 10 seconds, an HTTP error status, or an unexpected response.
 */
export const fetchPublishedVersions = async (
  options: RegistryOptions
): Promise<string[]> => {
  const registry = (
    envValue(options.env, "npm_config_registry") ?? DEFAULT_REGISTRY
  ).replace(TRAILING_SLASHES, "");

  const url = `${registry}/${PACKAGE_NAME.replace("/", "%2F")}`;

  const response = await options.fetch(url, {
    headers: { Accept: ABBREVIATED_PACKUMENT },
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`GET ${url} failed with HTTP ${response.status}`);
  }

  const parsed: unknown = await response.json();

  if (!Value.Check(PackumentSchema, parsed)) {
    throw new Error(`GET ${url} returned an unexpected response`);
  }

  return Object.keys(parsed.versions);
};
