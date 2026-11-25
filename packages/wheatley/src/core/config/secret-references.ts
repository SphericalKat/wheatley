import { isJsonValue } from "@wheatley-ai/protocol";
import type {
  DeploymentConfig,
  JsonValue,
  SecretInfo,
} from "@wheatley-ai/protocol";

/** One config entry that names a secret. */
export type SecretReference = SecretInfo["references"][number];

const isRecord = (
  value: JsonValue | undefined
): value is { readonly [key: string]: JsonValue } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSecretName = (value: JsonValue | undefined): value is string =>
  typeof value === "string";

/** Collects the names of every `{ secret: <name> }` object inside a JSON value. */
const secretNamesIn = (value: JsonValue | undefined): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap((item: JsonValue) => secretNamesIn(item));
  }

  if (!isRecord(value)) {
    return [];
  }

  const own =
    isSecretName(value.secret) && Object.keys(value).length === 1
      ? [value.secret]
      : [];

  return [
    ...own,
    ...Object.values(value).flatMap((child) => secretNamesIn(child)),
  ];
};

const add = (
  references: Map<string, SecretReference[]>,
  names: readonly string[],
  reference: SecretReference
): void => {
  for (const name of names) {
    const list = references.get(name) ?? [];

    if (
      !list.some(
        (item) =>
          item.kind === reference.kind &&
          item.id === reference.id &&
          item.agent === reference.agent
      )
    ) {
      list.push(reference);
    }

    references.set(name, list);
  }
};

/**
 * Lists the config entries that refer to each secret: provider API keys, Frontend Binding, MCP Server, and Plugin
 * config. Trigger token secrets live in `agent.sqlite`, so the Trigger module reports them.
 */
export const secretReferences = (
  config: DeploymentConfig
): ReadonlyMap<string, readonly SecretReference[]> => {
  const references = new Map<string, SecretReference[]>();

  for (const [provider, providerConfig] of Object.entries(
    config.providers ?? {}
  )) {
    if (providerConfig.apiKey !== undefined) {
      add(references, [providerConfig.apiKey.secret], {
        id: provider,
        kind: "provider",
      });
    }
  }

  for (const [agent, agentConfig] of Object.entries(config.agents)) {
    for (const binding of agentConfig.frontends ?? []) {
      add(
        references,
        secretNamesIn(isJsonValue(binding.config) ? binding.config : null),
        {
          agent,
          id: binding.id,
          kind: "frontend",
        }
      );
    }

    for (const [server, serverConfig] of Object.entries(
      agentConfig.mcpServers ?? {}
    )) {
      add(
        references,
        secretNamesIn(isJsonValue(serverConfig) ? serverConfig : null),
        {
          agent,
          id: server,
          kind: "mcp",
        }
      );
    }

    for (const plugin of agentConfig.plugins ?? []) {
      add(
        references,
        secretNamesIn(isJsonValue(plugin.config) ? plugin.config : null),
        {
          agent,
          id: plugin.source,
          kind: "plugin",
        }
      );
    }
  }

  return references;
};
