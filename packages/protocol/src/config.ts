import { Type } from "typebox";
import type { Static } from "typebox";

import {
  AgentNameSchema,
  DurationSchema,
  PermissionRuleSchema,
  SecretNameSchema,
} from "./domain.js";
import type { ModelRef } from "./domain.js";
import { CRON_EXPRESSION_MIN_LENGTH, MAX_TCP_PORT } from "./limits.js";
import { decode } from "./validation.js";

const strict = { additionalProperties: false } as const;

/** A reference to a secret by name. Config files never hold secret values (ADR 0004). */
export const SecretRefSchema = Type.Object(
  { secret: SecretNameSchema },
  strict
);

export type SecretRef = Static<typeof SecretRefSchema>;

/** A plain string or a secret reference, for headers and environment variables. */
export const StringOrSecretSchema = Type.Union([
  Type.String(),
  SecretRefSchema,
]);

export type StringOrSecret = Static<typeof StringOrSecretSchema>;

const EnvApiKeyRefSchema = Type.String({
  pattern: "^\\{env:[A-Z_][A-Z0-9_]*\\}$",
});

/** A reference to a provider API key: either `{ secret: NAME }` or OpenCode's `{env:NAME}` syntax. */
export const ApiKeyRefSchema = Type.Union([
  SecretRefSchema,
  EnvApiKeyRefSchema,
]);

export type ApiKeyRef = Static<typeof ApiKeyRefSchema>;

const ENV_REF_PATTERN = /^\{env:(?<name>[A-Z_][A-Z0-9_]*)\}$/u;

/** Returns the secret/environment variable name referenced by an `ApiKeyRef`. */
export const apiKeySecretName = (ref: ApiKeyRef): string => {
  const secretRef = decode(SecretRefSchema, ref);

  if (secretRef.ok) {
    return secretRef.value.secret;
  }

  const envRef = decode(EnvApiKeyRefSchema, ref);

  if (envRef.ok) {
    const match = ENV_REF_PATTERN.exec(envRef.value);

    return match?.groups?.name ?? envRef.value;
  }

  return "";
};

/** Thinking level override for an Agent or maintenance Run. */
export const ThinkingLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
]);

export type ThinkingLevel = Static<typeof ThinkingLevelSchema>;

/** A model identifier in OpenCode `<provider>/<model-id>` format, for example `anthropic/claude-sonnet-5-5`. */
export const ModelIdSchema = Type.String({ pattern: "^[^/\\s]+/[^\\s]+$" });

export type ModelId = Static<typeof ModelIdSchema>;

/** Splits a `<provider>/<id>` string on its first slash. */
export const parseModelId = (model: string): ModelRef => {
  const slash = model.indexOf("/");

  return slash === -1
    ? { id: model, provider: "" }
    : { id: model.slice(slash + 1), provider: model.slice(0, slash) };
};

/** Supported wire protocols for custom or overridden providers. */
export const ProviderApiSchema = Type.Union([
  Type.Literal("anthropic-messages"),
  Type.Literal("openai-completions"),
  Type.Literal("openai-responses"),
  Type.Literal("google-generative-ai"),
  Type.Literal("mistral-conversations"),
]);

export type ProviderApi = Static<typeof ProviderApiSchema>;

/** Custom or overridden model metadata under `provider.<id>.models.<model-id>`. */
export const ProviderModelConfigSchema = Type.Object(
  {
    api: Type.Optional(ProviderApiSchema),
    cost: Type.Optional(
      Type.Object(
        {
          cache_read: Type.Optional(Type.Number({ minimum: 0 })),
          cache_write: Type.Optional(Type.Number({ minimum: 0 })),
          input: Type.Optional(Type.Number({ minimum: 0 })),
          output: Type.Optional(Type.Number({ minimum: 0 })),
        },
        strict
      )
    ),
    headers: Type.Optional(Type.Record(Type.String(), StringOrSecretSchema)),
    limit: Type.Optional(
      Type.Object(
        {
          context: Type.Optional(Type.Integer({ minimum: 1 })),
          output: Type.Optional(Type.Integer({ minimum: 1 })),
        },
        strict
      )
    ),
    modalities: Type.Optional(
      Type.Object(
        {
          input: Type.Optional(
            Type.Array(
              Type.Union([Type.Literal("text"), Type.Literal("image")])
            )
          ),
          output: Type.Optional(Type.Array(Type.String())),
        },
        strict
      )
    ),
    name: Type.Optional(Type.String({ minLength: 1 })),
    reasoning: Type.Optional(Type.Boolean()),
  },
  strict
);

export type ProviderModelConfig = Static<typeof ProviderModelConfigSchema>;

/** Connection, credential, and concurrency options for one provider (OpenCode-style `provider.<id>.options`). */
export const ProviderOptionsSchema = Type.Object(
  {
    apiKey: Type.Optional(ApiKeyRefSchema),
    baseURL: Type.Optional(Type.String({ minLength: 1 })),
    headers: Type.Optional(Type.Record(Type.String(), StringOrSecretSchema)),
    maxConcurrent: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  strict
);

export type ProviderOptions = Static<typeof ProviderOptionsSchema>;

/** OpenCode-style provider entry under `provider.<id>`. Each provider key is one Concurrency Gate key. */
export const ProviderConfigSchema = Type.Object(
  {
    api: Type.Optional(ProviderApiSchema),
    models: Type.Optional(
      Type.Record(Type.String({ minLength: 1 }), ProviderModelConfigSchema)
    ),
    name: Type.Optional(Type.String({ minLength: 1 })),
    npm: Type.Optional(Type.String({ minLength: 1 })),
    options: Type.Optional(ProviderOptionsSchema),
  },
  strict
);

export type ProviderConfig = Static<typeof ProviderConfigSchema>;

/** The Control Server listener for the CLI and dashboard. */
export const DaemonConfigSchema = Type.Object(
  {
    /** Browser origins allowed to open `/ws`, in addition to the listener's own origin. */
    allowedOrigins: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    drainTimeout: Type.Optional(DurationSchema),
    host: Type.Optional(Type.String({ minLength: 1 })),
    port: Type.Optional(Type.Integer({ maximum: MAX_TCP_PORT, minimum: 1 })),
  },
  strict
);

export type DaemonConfig = Static<typeof DaemonConfigSchema>;

/** The Webhook Ingress listener. It is disabled unless `enabled` is true (ADR 0010). */
export const WebhooksConfigSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    host: Type.Optional(Type.String({ minLength: 1 })),
    port: Type.Optional(Type.Integer({ maximum: MAX_TCP_PORT, minimum: 1 })),
  },
  strict
);

export type WebhooksConfig = Static<typeof WebhooksConfigSchema>;

/** The Webhook Ingress host if `webhooks.host` is absent. A reverse proxy in front of it terminates TLS. */
export const DEFAULT_WEBHOOK_HOST = "127.0.0.1";

/** The Webhook Ingress port if `webhooks.port` is absent. */
export const DEFAULT_WEBHOOK_PORT = 8788;

/**
 * Returns the Webhook Ingress path of the webhook Trigger `triggerId` of `agent`: `/webhooks/<agent>/<triggerId>`.
 * The ingress matches the raw path segments without percent-decoding, so the parts stay unencoded. Agent names are
 * URL-safe by `AgentNameSchema`.
 */
export const webhookTriggerPath = (agent: string, triggerId: string): string =>
  `/webhooks/${agent}/${triggerId}`;

/** Memory settings of one Agent (ADR 0009). */
export const MemoryConfigSchema = Type.Object(
  {
    consolidation: Type.Optional(
      Type.Object(
        {
          enabled: Type.Optional(Type.Boolean()),
          model: Type.Optional(ModelIdSchema),
          schedule: Type.Optional(
            Type.String({ minLength: CRON_EXPRESSION_MIN_LENGTH })
          ),
          thinking: Type.Optional(ThinkingLevelSchema),
          timezone: Type.Optional(Type.String({ minLength: 1 })),
        },
        strict
      )
    ),
    /** The `MEMORY.md` character cap. The default is 4,000. */
    maxChars: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  strict
);

export type MemoryConfig = Static<typeof MemoryConfigSchema>;

/** One Plugin of an Agent: a local path or an npm package in `~/.wheatley/extensions/` (ADR 0006). */
export const PluginConfigSchema = Type.Object(
  {
    /** Validated against the Plugin's `configSchema`. */
    config: Type.Optional(Type.Unknown()),
    enabled: Type.Optional(Type.Boolean()),
    source: Type.String({ minLength: 1 }),
  },
  strict
);

export type PluginConfig = Static<typeof PluginConfigSchema>;

/** One MCP Server of an Agent. The record key in `mcpServers` is its name in `mcp:<server>:<tool>`. */
export const McpServerConfigSchema = Type.Union([
  Type.Object(
    {
      args: Type.Optional(Type.Array(Type.String())),
      command: Type.String({ minLength: 1 }),
      cwd: Type.Optional(Type.String({ minLength: 1 })),
      enabled: Type.Optional(Type.Boolean()),
      env: Type.Optional(Type.Record(Type.String(), StringOrSecretSchema)),
      transport: Type.Literal("stdio"),
    },
    strict
  ),
  Type.Object(
    {
      enabled: Type.Optional(Type.Boolean()),
      headers: Type.Optional(Type.Record(Type.String(), StringOrSecretSchema)),
      transport: Type.Literal("http"),
      url: Type.String({ minLength: 1 }),
    },
    strict
  ),
]);

export type McpServerConfig = Static<typeof McpServerConfigSchema>;

/** One Frontend Binding of an Agent. */
export const FrontendBindingConfigSchema = Type.Object(
  {
    /** Validated against the Frontend's `configSchema`. Chat Frontends require a non-empty `allowedChatIds`. */
    config: Type.Unknown(),
    enabled: Type.Optional(Type.Boolean()),
    /** Unique within the Agent. `cli` is reserved for the Control Server's CLI binding. */
    id: Type.String({ pattern: "^[a-z][a-z0-9-]{0,62}$" }),
    type: Type.String({ minLength: 1 }),
  },
  strict
);

export type FrontendBindingConfig = Static<typeof FrontendBindingConfigSchema>;

/** Settings of one Agent. */
export const AgentConfigSchema = Type.Object(
  {
    /** The Approval timeout. The default is `15m`; `null` disables the timeout (ADR 0011). */
    approvalTimeout: Type.Optional(Type.Union([DurationSchema, Type.Null()])),
    frontends: Type.Optional(Type.Array(FrontendBindingConfigSchema)),
    instructions: Type.Optional(Type.String()),
    maxConcurrentRuns: Type.Optional(Type.Integer({ minimum: 1 })),
    mcpServers: Type.Optional(
      Type.Record(
        Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{0,62}$" }),
        McpServerConfigSchema,
        strict
      )
    ),
    memory: Type.Optional(MemoryConfigSchema),
    model: ModelIdSchema,
    /** Ordered rules. The first match wins. */
    permissionPolicy: Type.Optional(Type.Array(PermissionRuleSchema)),
    plugins: Type.Optional(Type.Array(PluginConfigSchema)),
    skills: Type.Optional(
      Type.Object(
        { disabled: Type.Optional(Type.Array(Type.String())) },
        strict
      )
    ),
    thinking: Type.Optional(ThinkingLevelSchema),
  },
  strict
);

export type AgentConfig = Static<typeof AgentConfigSchema>;

/** The contents of `config.yaml`. */
export const DeploymentConfigSchema = Type.Object(
  {
    agents: Type.Record(AgentNameSchema, AgentConfigSchema, strict),
    daemon: Type.Optional(DaemonConfigSchema),
    provider: Type.Optional(Type.Record(Type.String(), ProviderConfigSchema)),
    version: Type.Literal(1),
    webhooks: Type.Optional(WebhooksConfigSchema),
  },
  strict
);

export type DeploymentConfig = Static<typeof DeploymentConfigSchema>;
