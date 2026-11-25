import { createHash } from "node:crypto";

import {
  DeploymentConfigSchema,
  decode,
  isJsonValue,
} from "@wheatley/protocol";
import type {
  DeploymentConfig,
  PermissionRule,
  ConfigIssue,
} from "@wheatley/protocol";

import type {
  ConfigSaveInput,
  ConfigSnapshot,
  ConfigStore,
} from "./config-store.js";
import { SeamError } from "./errors.js";
import { simulateIo } from "./fake-io.js";
import { InMemorySecretStore } from "./secret-store.fake.js";

const revisionOf = (raw: string): string =>
  createHash("sha256").update(raw).digest("hex");

/** JSON is valid YAML, so the fake stores config as indented JSON text. */
const render = (config: DeploymentConfig): string =>
  `${JSON.stringify(config, null, 2)}\n`;

const parseRaw = (
  raw: string
):
  | { readonly config: DeploymentConfig }
  | { readonly issues: ConfigIssue[] } => {
  let value: unknown;

  try {
    value = JSON.parse(raw);
  } catch {
    return {
      issues: [
        {
          message: "The fake ConfigStore accepts JSON-formatted YAML only",
          path: "/",
        },
      ],
    };
  }

  if (!isJsonValue(value)) {
    return { issues: [{ message: "Not a JSON value", path: "/" }] };
  }

  const decoded = decode(DeploymentConfigSchema, value);

  return decoded.ok
    ? { config: decoded.value }
    : { issues: [...decoded.issues] };
};

const validateRaw = async (raw: string): Promise<readonly ConfigIssue[]> => {
  await simulateIo();
  const parsed = parseRaw(raw);

  return "issues" in parsed ? parsed.issues : [];
};

/** An in-memory `ConfigStore` with the same revision, validation, and rule semantics as the real one. */
export class InMemoryConfigStore implements ConfigStore {
  readonly secrets: InMemorySecretStore;
  #raw: string;
  #config: DeploymentConfig;

  constructor(
    config: DeploymentConfig,
    secrets: InMemorySecretStore = new InMemorySecretStore()
  ) {
    this.#config = config;
    this.#raw = render(config);
    this.secrets = secrets;
  }

  readonly read = async (): Promise<ConfigSnapshot> => {
    await simulateIo();

    return this.#snapshot();
  };

  readonly validate = validateRaw;

  readonly save = async (
    input: ConfigSaveInput,
    expectedRevision: string
  ): Promise<ConfigSnapshot> => {
    await simulateIo();
    const current = revisionOf(this.#raw);

    if (expectedRevision !== current) {
      throw new SeamError(
        "revision_conflict",
        "config.yaml changed since it was read",
        { revision: current }
      );
    }

    const raw = "raw" in input ? input.raw : render(input.config);
    const parsed = parseRaw(raw);

    if ("issues" in parsed) {
      throw new SeamError("config_invalid", "config.yaml is invalid", {
        issues: parsed.issues,
      });
    }

    this.#raw = raw;
    this.#config = parsed.config;

    return this.#snapshot();
  };

  readonly prependPermissionRule = async (
    agent: string,
    rule: PermissionRule
  ): Promise<ConfigSnapshot> => {
    await simulateIo();
    const agentConfig = this.#config.agents[agent];

    if (agentConfig === undefined) {
      throw new SeamError("not_found", `Unknown Agent: ${agent}`);
    }

    const policy = agentConfig.permissionPolicy ?? [];
    const [first] = policy;

    if (first?.tool === rule.tool && first.action === rule.action) {
      return this.#snapshot();
    }

    this.#config = {
      ...this.#config,
      agents: {
        ...this.#config.agents,
        [agent]: { ...agentConfig, permissionPolicy: [rule, ...policy] },
      },
    };
    this.#raw = render(this.#config);

    return this.#snapshot();
  };

  readonly #snapshot = (): ConfigSnapshot => ({
    config: this.#config,
    raw: this.#raw,
    revision: revisionOf(this.#raw),
  });
}
