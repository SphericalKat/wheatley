import { stat } from "node:fs/promises";
import path from "node:path";

import { decode, isJsonValue } from "@wheatley-ai/protocol";
import { Type } from "typebox";
import type { Static } from "typebox";

import { readTextIfExists, writeFileAtomic } from "./config/atomic-file.js";

/** Cached models.dev catalog filename inside the Wheatley home directory. */
export const MODELS_DEV_CACHE_FILE = "models-dev-cache.json";

/** Default models.dev catalog URL. */
export const MODELS_DEV_URL = "https://models.dev/api.json";

const MODELS_DEV_CACHE_MODE = 0o644;
const MODELS_DEV_TTL_MS = 24 * 60 * 60 * 1000;
const MODELS_DEV_FETCH_TIMEOUT_MS = 5000;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

const RawModelsDevModelSchema = Type.Object({
  attachment: Type.Optional(Type.Boolean()),
  cost: Type.Optional(
    Type.Object({
      cache_read: Type.Optional(Type.Number()),
      cache_write: Type.Optional(Type.Number()),
      input: Type.Optional(Type.Number()),
      output: Type.Optional(Type.Number()),
    })
  ),
  id: Type.Optional(Type.String()),
  limit: Type.Optional(
    Type.Object({
      context: Type.Optional(Type.Number()),
      output: Type.Optional(Type.Number()),
    })
  ),
  modalities: Type.Optional(
    Type.Object({
      input: Type.Optional(Type.Array(Type.String())),
    })
  ),
  name: Type.Optional(Type.String()),
  reasoning: Type.Optional(Type.Boolean()),
});

type RawModelsDevModel = Static<typeof RawModelsDevModelSchema>;

const RawModelsDevProviderSchema = Type.Object({
  api: Type.Optional(Type.String()),
  env: Type.Optional(Type.Array(Type.String())),
  id: Type.Optional(Type.String()),
  models: Type.Optional(Type.Record(Type.String(), RawModelsDevModelSchema)),
  name: Type.Optional(Type.String()),
  npm: Type.Optional(Type.String()),
});

const RawModelsDevCatalogSchema = Type.Record(
  Type.String(),
  RawModelsDevProviderSchema
);

/** Normalized model metadata from models.dev. */
export interface ModelsDevModel {
  readonly id: string;
  readonly name: string;
  readonly reasoning: boolean;
  readonly input: readonly ("text" | "image")[];
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly cost: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
  };
}

/** Normalized provider entry from models.dev. */
export interface ModelsDevProvider {
  readonly id: string;
  readonly name: string;
  readonly npm: string | undefined;
  readonly api: string | undefined;
  readonly env: readonly string[];
  readonly models: ReadonlyMap<string, ModelsDevModel>;
}

/** Parsed models.dev catalog with provider and model lookups. */
export interface ModelsDevCatalog {
  readonly providers: ReadonlyMap<string, ModelsDevProvider>;
  readonly findModel: (
    providerId: string,
    modelId: string
  ) => ModelsDevModel | undefined;
  readonly findModelById: (modelId: string) => ModelsDevModel | undefined;
}

/** Options of `loadModelsDevCatalog`. */
export interface LoadModelsDevOptions {
  readonly homeDir?: string;
  readonly url?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly ttlMs?: number;
}

const positiveOrDefault = (
  value: number | undefined,
  fallback: number
): number =>
  value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : fallback;

const parseInputModalities = (
  raw: RawModelsDevModel
): readonly ("text" | "image")[] => {
  const inputs = (raw.modalities?.input ?? []).filter(
    (item): item is "text" | "image" => item === "text" || item === "image"
  );

  if (inputs.length > 0) {
    return inputs;
  }

  return raw.attachment === true ? ["text", "image"] : ["text"];
};

const normalizeModel = (
  key: string,
  raw: RawModelsDevModel
): ModelsDevModel => ({
  contextWindow: positiveOrDefault(raw.limit?.context, DEFAULT_CONTEXT_WINDOW),
  cost: {
    cacheRead: positiveOrDefault(raw.cost?.cache_read, 0),
    cacheWrite: positiveOrDefault(raw.cost?.cache_write, 0),
    input: positiveOrDefault(raw.cost?.input, 0),
    output: positiveOrDefault(raw.cost?.output, 0),
  },
  id: raw.id !== undefined && raw.id.length > 0 ? raw.id : key,
  input: parseInputModalities(raw),
  maxTokens: positiveOrDefault(raw.limit?.output, DEFAULT_MAX_TOKENS),
  name: raw.name !== undefined && raw.name.length > 0 ? raw.name : key,
  reasoning: raw.reasoning === true,
});

/** Parses raw JSON text from `https://models.dev/api.json` into a `ModelsDevCatalog`. */
export const parseModelsDevCatalog = (text: string): ModelsDevCatalog => {
  const providers = new Map<string, ModelsDevProvider>();
  const modelsById = new Map<string, ModelsDevModel>();
  const parsedJson: unknown = JSON.parse(text);

  const decoded = isJsonValue(parsedJson)
    ? decode(RawModelsDevCatalogSchema, parsedJson)
    : undefined;

  if (decoded?.ok === true) {
    for (const [providerId, entry] of Object.entries(decoded.value)) {
      const models = new Map<string, ModelsDevModel>();

      for (const [modelKey, rawModel] of Object.entries(entry.models ?? {})) {
        const parsed = normalizeModel(modelKey, rawModel);

        models.set(parsed.id, parsed);

        if (!modelsById.has(parsed.id)) {
          modelsById.set(parsed.id, parsed);
        }
      }

      providers.set(providerId, {
        api:
          entry.api !== undefined && entry.api.length > 0
            ? entry.api
            : undefined,
        env: (entry.env ?? []).filter((name) => name.length > 0),
        id:
          entry.id !== undefined && entry.id.length > 0 ? entry.id : providerId,
        models,
        name:
          entry.name !== undefined && entry.name.length > 0
            ? entry.name
            : providerId,
        npm:
          entry.npm !== undefined && entry.npm.length > 0
            ? entry.npm
            : undefined,
      });
    }
  }

  return {
    findModel: (providerId, modelId) =>
      providers.get(providerId)?.models.get(modelId),
    findModelById: (modelId) => modelsById.get(modelId),
    providers,
  };
};

const readCachedCatalog = async (
  cachePath: string,
  now: number,
  ttlMs: number
): Promise<{
  readonly catalog?: ModelsDevCatalog;
  readonly fresh: boolean;
}> => {
  const text = await readTextIfExists(cachePath);

  if (text === undefined) {
    return { fresh: false };
  }

  try {
    const info = await stat(cachePath);
    const catalog = parseModelsDevCatalog(text);
    const fresh = now - info.mtimeMs < ttlMs;

    return { catalog, fresh };
  } catch {
    return { fresh: false };
  }
};

/**
 * Loads the models.dev catalog from `<homeDir>/models-dev-cache.json`, refreshing from `https://models.dev/api.json`
 * when the cache is absent or older than `ttlMs`. Falls back to stale cache or `undefined` when offline.
 */
export const loadModelsDevCatalog = async (
  options: LoadModelsDevOptions = {}
): Promise<ModelsDevCatalog | undefined> => {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? MODELS_DEV_TTL_MS;

  const cachePath =
    options.homeDir === undefined
      ? undefined
      : path.join(options.homeDir, MODELS_DEV_CACHE_FILE);

  const cached =
    cachePath === undefined
      ? { catalog: undefined, fresh: false }
      : await readCachedCatalog(cachePath, now(), ttlMs);

  if (cached.fresh && cached.catalog !== undefined) {
    return cached.catalog;
  }

  if (
    options.fetch === undefined &&
    process.env.WHEATLEY_DISABLE_MODELS_DEV === "1"
  ) {
    return cached.catalog;
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;

  try {
    const response = await fetchImpl(options.url ?? MODELS_DEV_URL, {
      signal: AbortSignal.timeout(MODELS_DEV_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      return cached.catalog;
    }

    const text = await response.text();
    const catalog = parseModelsDevCatalog(text);

    if (cachePath !== undefined) {
      await writeFileAtomic(cachePath, text, MODELS_DEV_CACHE_MODE);
    }

    return catalog;
  } catch {
    return cached.catalog;
  }
};
