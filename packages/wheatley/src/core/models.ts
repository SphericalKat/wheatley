import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { DeploymentConfig } from "@wheatley/protocol";
import type { SecretReader } from "@wheatley/sdk";

/**
 * Builds pi-ai `Models` with every built-in provider. A provider entry in `config.yaml` with `apiKey` gets that secret
 * as its API key credential. A provider without one uses pi-ai's own environment lookup, for example
 * `ANTHROPIC_API_KEY`.
 *
 * Errors: rejects if a provider names an `apiKey` secret that neither `secrets.yaml` nor the environment holds.
 */
export const createProviderModels = async (
  config: DeploymentConfig,
  secrets: SecretReader
): Promise<Models> => {
  const credentials = new InMemoryCredentialStore();

  for (const [provider, providerConfig] of Object.entries(
    config.providers ?? {}
  )) {
    if (providerConfig.apiKey === undefined) {
      continue;
    }

    const key = secrets.get(providerConfig.apiKey.secret);

    if (key === undefined) {
      throw new Error(
        `The API key secret ${providerConfig.apiKey.secret} of provider ${provider} is not set`
      );
    }

    // oxlint-disable-next-line no-await-in-loop -- The credential store serializes writes per provider anyway.
    await credentials.modify(provider, async () => {
      await Promise.resolve();

      return { key, type: "api_key" };
    });
  }

  return builtinModels({ credentials });
};
