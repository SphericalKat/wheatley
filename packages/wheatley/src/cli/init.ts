import { mkdir } from "node:fs/promises";
import path from "node:path";

import { AgentNameSchema, decode } from "@wheatley-ai/protocol";

import {
  readTextIfExists,
  writeFileAtomic,
} from "../core/config/atomic-file.js";
import {
  CONFIG_FILE_MODE,
  CONFIG_FILE_NAME,
  SECRETS_FILE_NAME,
} from "../core/config/config-store.js";
import { SECRETS_FILE_MODE } from "../core/config/secret-store.js";
import { parseConfigText } from "../core/config/validate.js";
import { AGENTS_DIR } from "../core/deployment.js";
import type { CliIo } from "./io.js";

/** The model of the first Agent when `init` gets no `--provider` and `--model`. */
export const DEFAULT_PROVIDER = "anthropic";
export const DEFAULT_MODEL = "claude-sonnet-5-5";

/** The name of the first Agent when `init` gets no `--agent`. */
export const DEFAULT_AGENT = "default";

/** Options of `wheatley init`. */
export interface InitOptions {
  readonly home: string;
  readonly agent: string | undefined;
  readonly provider: string | undefined;
  readonly model: string | undefined;
}

/** The environment variable name that holds the API key of a provider, for example `ANTHROPIC_API_KEY`. */
const apiKeySecret = (provider: string): string =>
  `${provider.toUpperCase().replaceAll(/[^A-Z0-9]/gu, "_")}_API_KEY`;

const configTemplate = (
  agent: string,
  provider: string,
  model: string
): string => `# Wheatley Deployment settings (ADR 0004).
# Save changes, then restart the changed Agent: wheatley restarts no Agent on its own.
version: 1

provider:
  ${provider}:
    options:
      # The API key is a secret: set it in secrets.yaml or as an environment variable.
      apiKey: "{env:${apiKeySecret(provider)}}"

agents:
  ${agent}:
    model: ${provider}/${model}
    # Rules match canonical Tool names. The first match wins. Without a match, read_file is allowed, and
    # write_file and shell ask for an Approval.
    permissionPolicy:
      - tool: read_file
        action: allow
`;

const secretsTemplate = (
  provider: string
): string => `# Wheatley secrets. Keep this file private (mode 0600).
# An environment variable with the same name wins over a value here.
# ${apiKeySecret(provider)}: <your API key>
`;

/**
 * `wheatley init`: creates the Deployment home with `config.yaml`, an owner-only `secrets.yaml`, and the first Agent's
 * folder. It never overwrites an existing `config.yaml`. Resolves with the exit code.
 */
export const runInit = async (
  io: CliIo,
  options: InitOptions
): Promise<number> => {
  const agent = options.agent ?? DEFAULT_AGENT;
  const provider = options.provider ?? DEFAULT_PROVIDER;
  const model = options.model ?? DEFAULT_MODEL;
  const configFile = path.join(options.home, CONFIG_FILE_NAME);
  const secretsFile = path.join(options.home, SECRETS_FILE_NAME);

  if (!decode(AgentNameSchema, agent).ok) {
    io.stderr(
      `Invalid Agent name: ${agent}. Use lowercase letters, digits, and hyphens.\n`
    );

    return 1;
  }

  if ((await readTextIfExists(configFile)) !== undefined) {
    io.stderr(
      `${configFile} already exists. Edit it, or remove it to start again.\n`
    );

    return 1;
  }

  const config = configTemplate(agent, provider, model);
  const parsed = parseConfigText(config);

  if (!parsed.ok) {
    io.stderr(
      `The generated config is invalid: ${parsed.issues.map((issue) => issue.message).join("; ")}\n`
    );

    return 1;
  }

  await mkdir(path.join(options.home, AGENTS_DIR, agent), { recursive: true });
  await writeFileAtomic(configFile, config, CONFIG_FILE_MODE);

  if ((await readTextIfExists(secretsFile)) === undefined) {
    await writeFileAtomic(
      secretsFile,
      secretsTemplate(provider),
      SECRETS_FILE_MODE
    );
  }

  io.stdout(
    `Created ${configFile} with the Agent "${agent}" (${provider}/${model}).\nSet ${apiKeySecret(provider)} in ${secretsFile} or the environment, then run "wheatley daemon".\n`
  );

  return 0;
};
