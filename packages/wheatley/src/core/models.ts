import {
  createProvider,
  envApiKeyAuth,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import type {
  Api,
  CreateProviderOptions,
  Model,
  Models,
  ProviderStreams,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { mistralConversationsApi } from "@earendil-works/pi-ai/api/mistral-conversations.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  apiKeySecretName,
  decode,
  SecretRefSchema,
} from "@wheatley-ai/protocol";
import type {
  DeploymentConfig,
  ProviderApi,
  ProviderConfig,
  ProviderModelConfig,
  StringOrSecret,
} from "@wheatley-ai/protocol";
import type { SecretReader } from "@wheatley-ai/sdk";
import { Type } from "typebox";

import { loadModelsDevCatalog } from "./models-dev.js";
import type {
  ModelsDevCatalog,
  ModelsDevModel,
  ModelsDevProvider,
} from "./models-dev.js";

/** Options of `createProviderModels`. */
export interface CreateProviderModelsOptions {
  /** Wheatley home directory where `models-dev-cache.json` is stored. */
  readonly homeDir?: string;
  /** Preloaded models.dev catalog (skips cache and network when provided). */
  readonly catalog?: ModelsDevCatalog;
  /** Custom fetch implementation for models.dev refreshes. */
  readonly fetch?: typeof globalThis.fetch;
}

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

const NPM_TO_API = new Map<string, ProviderApi>([
  ["@ai-sdk/anthropic", "anthropic-messages"],
  ["@ai-sdk/cerebras", "openai-completions"],
  ["@ai-sdk/deepseek", "openai-completions"],
  ["@ai-sdk/fireworks", "openai-completions"],
  ["@ai-sdk/google", "google-generative-ai"],
  ["@ai-sdk/groq", "openai-completions"],
  ["@ai-sdk/mistral", "mistral-conversations"],
  ["@ai-sdk/openai", "openai-responses"],
  ["@ai-sdk/openai-compatible", "openai-completions"],
  ["@ai-sdk/openrouter", "openai-completions"],
  ["@ai-sdk/perplexity", "openai-completions"],
  ["@ai-sdk/togetherai", "openai-completions"],
  ["@ai-sdk/xai", "openai-completions"],
]);

const API_STREAM_FACTORIES: Readonly<
  Record<ProviderApi, () => ProviderStreams>
> = {
  "anthropic-messages": anthropicMessagesApi,
  "google-generative-ai": googleGenerativeAIApi,
  "mistral-conversations": mistralConversationsApi,
  "openai-completions": openAICompletionsApi,
  "openai-responses": openAIResponsesApi,
};

const apiStreams = (api: ProviderApi): ProviderStreams =>
  API_STREAM_FACTORIES[api]();

const isSupportedApi = (api: string): api is ProviderApi =>
  api in API_STREAM_FACTORIES;

/** Maps an OpenCode `npm` package name to a pi-ai wire protocol, or `undefined` if unsupported. */
export const npmToProviderApi = (
  npm: string | undefined
): ProviderApi | undefined =>
  npm === undefined ? undefined : NPM_TO_API.get(npm);

const PlainStringSchema = Type.String();

const resolveHeaders = (
  raw: Readonly<Record<string, StringOrSecret>> | undefined,
  secrets: SecretReader,
  context: string
): Record<string, string> | undefined => {
  if (raw === undefined) {
    return undefined;
  }

  const resolved: Record<string, string> = {};

  for (const [name, value] of Object.entries(raw)) {
    const plain = decode(PlainStringSchema, value);

    if (plain.ok) {
      resolved[name] = plain.value;
      continue;
    }

    const secretRef = decode(SecretRefSchema, value);

    if (!secretRef.ok) {
      continue;
    }

    const secret = secrets.get(secretRef.value.secret);

    if (secret === undefined) {
      throw new Error(
        `The header secret ${secretRef.value.secret} of ${context} is not set`
      );
    }

    resolved[name] = secret;
  }

  return resolved;
};

const modelFromCatalog = (
  providerId: string,
  entry: ModelsDevModel,
  api: ProviderApi,
  baseUrl: string
): Model<Api> => ({
  api,
  baseUrl,
  contextWindow: entry.contextWindow,
  cost: entry.cost,
  id: entry.id,
  input: [...entry.input],
  maxTokens: entry.maxTokens,
  name: entry.name,
  provider: providerId,
  reasoning: entry.reasoning,
});

const defaultModel = (
  providerId: string,
  modelId: string,
  api: ProviderApi,
  baseUrl: string
): Model<Api> => ({
  api,
  baseUrl,
  contextWindow: DEFAULT_CONTEXT_WINDOW,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
  id: modelId,
  input: ["text"],
  maxTokens: DEFAULT_MAX_TOKENS,
  name: modelId,
  provider: providerId,
  reasoning: false,
});

const stripCompat = (model: Model<Api>): Model<Api> => {
  const { compat: _compat, ...rest } = model;

  return rest;
};

const mergeCost = (
  base: Model<Api>["cost"],
  override: ProviderModelConfig["cost"]
): Model<Api>["cost"] => ({
  cacheRead: override?.cache_read ?? base.cacheRead,
  cacheWrite: override?.cache_write ?? base.cacheWrite,
  input: override?.input ?? base.input,
  output: override?.output ?? base.output,
});

const applyModelOverride = (
  base: Model<Api>,
  override: ProviderModelConfig,
  secrets: SecretReader
): Model<Api> => {
  const api = override.api ?? base.api;
  const source = api === base.api ? base : stripCompat(base);

  const modelHeaders = resolveHeaders(
    override.headers,
    secrets,
    `model ${base.provider}/${base.id}`
  );

  const next: Model<Api> = {
    ...source,
    api,
    contextWindow: override.limit?.context ?? base.contextWindow,
    cost: mergeCost(base.cost, override.cost),
    input:
      override.modalities?.input === undefined
        ? base.input
        : [...override.modalities.input],
    maxTokens: override.limit?.output ?? base.maxTokens,
    name: override.name ?? base.name,
    reasoning: override.reasoning ?? base.reasoning,
  };

  if (base.headers !== undefined || modelHeaders !== undefined) {
    return { ...next, headers: { ...base.headers, ...modelHeaders } };
  }

  return next;
};

const registerCatalogProviders = (
  models: ReturnType<typeof builtinModels>,
  catalog: ModelsDevCatalog
): void => {
  const existingIds = new Set(models.getProviders().map((item) => item.id));

  for (const [providerId, entry] of catalog.providers) {
    if (existingIds.has(providerId)) {
      continue;
    }

    const api = npmToProviderApi(entry.npm);

    if (
      api === undefined ||
      entry.api === undefined ||
      entry.models.size === 0
    ) {
      continue;
    }

    const providerModels = [...entry.models.values()].map((model) =>
      modelFromCatalog(providerId, model, api, entry.api ?? "")
    );

    models.setProvider(
      createProvider({
        api: apiStreams(api),
        auth: {
          apiKey: envApiKeyAuth(entry.name, entry.env),
        },
        baseUrl: entry.api,
        id: providerId,
        models: providerModels,
        name: entry.name,
      })
    );
  }
};

const collectProviderModels = (
  providerId: string,
  providerConfig: ProviderConfig,
  existingModels: readonly Model<Api>[],
  catalog: ModelsDevCatalog | undefined,
  catalogProvider: ModelsDevProvider | undefined,
  explicitApi: ProviderApi | undefined,
  defaultApi: ProviderApi,
  baseUrl: string,
  secrets: SecretReader
): Model<Api>[] => {
  const merged = new Map<string, Model<Api>>();

  for (const model of existingModels) {
    const nextApi = explicitApi ?? model.api;
    const source = nextApi === model.api ? model : stripCompat(model);

    merged.set(model.id, {
      ...source,
      api: nextApi,
      baseUrl: providerConfig.options?.baseURL ?? model.baseUrl,
    });
  }

  for (const [modelId, entry] of catalogProvider?.models ?? []) {
    if (!merged.has(modelId)) {
      merged.set(
        modelId,
        modelFromCatalog(providerId, entry, defaultApi, baseUrl)
      );
    }
  }

  for (const [modelId, override] of Object.entries(
    providerConfig.models ?? {}
  )) {
    const catalogEntry =
      catalog?.findModel(providerId, modelId) ??
      catalog?.findModelById(modelId);

    const baseline =
      merged.get(modelId) ??
      (catalogEntry === undefined
        ? defaultModel(providerId, modelId, defaultApi, baseUrl)
        : modelFromCatalog(providerId, catalogEntry, defaultApi, baseUrl));

    merged.set(modelId, applyModelOverride(baseline, override, secrets));
  }

  return [...merged.values()];
};

const buildApiMap = (
  models: readonly Model<Api>[],
  defaultApi: ProviderApi
): Partial<Record<Api, ProviderStreams>> => {
  const apiMap: Partial<Record<Api, ProviderStreams>> = {};

  for (const model of models) {
    if (isSupportedApi(model.api)) {
      apiMap[model.api] ??= apiStreams(model.api);
    }
  }

  apiMap[defaultApi] ??= apiStreams(defaultApi);

  return apiMap;
};

const resolveDefaultApi = (
  explicitApi: ProviderApi | undefined,
  catalogProvider: ModelsDevProvider | undefined,
  existingModels: readonly Model<Api>[]
): ProviderApi => {
  if (explicitApi !== undefined) {
    return explicitApi;
  }

  const catalogApi = npmToProviderApi(catalogProvider?.npm);

  if (catalogApi !== undefined) {
    return catalogApi;
  }

  const existingApi = existingModels[0]?.api;

  if (existingApi !== undefined && isSupportedApi(existingApi)) {
    return existingApi;
  }

  return "openai-completions";
};

const buildConfiguredProvider = (
  providerId: string,
  providerConfig: ProviderConfig,
  existingModels: readonly Model<Api>[],
  existingProvider: ReturnType<ReturnType<typeof builtinModels>["getProvider"]>,
  catalog: ModelsDevCatalog | undefined,
  catalogProvider: ModelsDevProvider | undefined,
  secrets: SecretReader
): ReturnType<typeof createProvider> => {
  const explicitApi =
    providerConfig.api ?? npmToProviderApi(providerConfig.npm);

  const defaultApi = resolveDefaultApi(
    explicitApi,
    catalogProvider,
    existingModels
  );

  const baseUrl =
    providerConfig.options?.baseURL ??
    catalogProvider?.api ??
    existingModels[0]?.baseUrl ??
    "";

  const providerHeaders = resolveHeaders(
    providerConfig.options?.headers,
    secrets,
    `provider ${providerId}`
  );

  const finalModels = collectProviderModels(
    providerId,
    providerConfig,
    existingModels,
    catalog,
    catalogProvider,
    explicitApi,
    defaultApi,
    baseUrl,
    secrets
  );

  const displayName =
    providerConfig.name ??
    catalogProvider?.name ??
    existingProvider?.name ??
    providerId;

  const auth = existingProvider?.auth ?? {
    apiKey: envApiKeyAuth(displayName, catalogProvider?.env ?? []),
  };

  const options: CreateProviderOptions = {
    api: buildApiMap(finalModels, defaultApi),
    auth,
    id: providerId,
    models: finalModels,
    name: displayName,
  };

  if (baseUrl !== "") {
    options.baseUrl = baseUrl;
  }

  if (providerHeaders !== undefined) {
    options.headers = providerHeaders;
  }

  return createProvider(options);
};

const hasProviderOverrides = (providerConfig: ProviderConfig): boolean =>
  providerConfig.api !== undefined ||
  providerConfig.npm !== undefined ||
  providerConfig.name !== undefined ||
  providerConfig.options?.baseURL !== undefined ||
  providerConfig.options?.headers !== undefined ||
  providerConfig.models !== undefined;

/**
 * Builds pi-ai `Models` from pi-ai built-ins, the cached models.dev catalog, and OpenCode-style `config.provider`
 * entries. A provider entry with `options.apiKey` gets that secret as its API key credential; custom `npm`/`api`,
 * `options.baseURL`, `options.headers`, and `models` entries override or define providers and models.
 *
 * Errors: rejects if a provider names an `apiKey` or header secret that neither `secrets.yaml` nor the environment
 * holds.
 */
export const createProviderModels = async (
  config: DeploymentConfig,
  secrets: SecretReader,
  options: CreateProviderModelsOptions = {}
): Promise<Models> => {
  const credentials = new InMemoryCredentialStore();
  const configuredProviders = config.provider ?? {};

  for (const [providerId, providerConfig] of Object.entries(
    configuredProviders
  )) {
    const apiKeyRef = providerConfig.options?.apiKey;

    if (apiKeyRef === undefined) {
      continue;
    }

    const secretName = apiKeySecretName(apiKeyRef);
    const key = secrets.get(secretName);

    if (key === undefined) {
      throw new Error(
        `The API key secret ${secretName} of provider ${providerId} is not set`
      );
    }

    // oxlint-disable-next-line no-await-in-loop -- The credential store serializes writes per provider anyway.
    await credentials.modify(providerId, async () => {
      await Promise.resolve();

      return { key, type: "api_key" };
    });
  }

  const models = builtinModels({ credentials });

  const catalog =
    options.catalog ??
    (options.homeDir === undefined && options.fetch === undefined
      ? undefined
      : await loadModelsDevCatalog({
          fetch: options.fetch,
          homeDir: options.homeDir,
        }));

  if (catalog !== undefined) {
    registerCatalogProviders(models, catalog);
  }

  for (const [providerId, providerConfig] of Object.entries(
    configuredProviders
  )) {
    const existingProvider = models.getProvider(providerId);

    if (
      existingProvider !== undefined &&
      !hasProviderOverrides(providerConfig)
    ) {
      continue;
    }

    models.setProvider(
      buildConfiguredProvider(
        providerId,
        providerConfig,
        models.getModels(providerId),
        existingProvider,
        catalog,
        catalog?.providers.get(providerId),
        secrets
      )
    );
  }

  return models;
};
