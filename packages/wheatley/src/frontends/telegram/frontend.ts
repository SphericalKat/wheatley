import type { Frontend } from "@wheatley/sdk";

import type { RpcHandlerMap } from "../../contracts/module.js";
import type { Migration } from "../../db/migrations.js";
import { createTelegramBinding } from "./binding.js";
import type { TelegramClient } from "./client.js";
import {
  formatIssues,
  telegramConfigSchema,
  validateTelegramConfig,
} from "./config.js";

/** The `type` of Telegram Frontend Bindings in `config.yaml`, and the module name of this track. */
export const TELEGRAM_FRONTEND_TYPE = "telegram";

/**
 * The `agent.sqlite` migrations of the Telegram Frontend. It has none: it keeps its Approval prompts in the binding's
 * `FrontendContext.dataDir`.
 */
export const telegramMigrations: readonly Migration[] = [];

/** The JSON-RPC handlers of the Telegram Frontend. It has none: Frontend Bindings report through `agent.status`. */
export const telegramRpcHandlers: RpcHandlerMap = {};

/** Creates a Telegram Bot API client for a bot token. */
export type TelegramClientFactory = (token: string) => Promise<TelegramClient>;

const loadGrammyClient: TelegramClientFactory = async (token) => {
  const { createGrammyClient } = await import("./grammy-client.js");

  return await createGrammyClient(token);
};

/** Options of `createTelegramFrontend`. */
export interface TelegramFrontendOptions {
  /** Creates the Bot API client. The default imports `grammy` lazily, on the first binding (ADR 0012). */
  readonly createClient?: TelegramClientFactory;
}

/**
 * Creates the built-in Telegram Frontend.
 *
 * `createBinding` throws if the config is invalid, if the bot token secret is missing, or if webhook mode is configured
 * while the Webhook Ingress is disabled.
 */
export const createTelegramFrontend = (
  options: TelegramFrontendOptions = {}
): Frontend => {
  const createClient = options.createClient ?? loadGrammyClient;

  return {
    configSchema: telegramConfigSchema,
    createBinding: async (rawConfig, ctx) => {
      const validated = validateTelegramConfig(rawConfig);

      if (validated.issues !== undefined) {
        throw new Error(
          `Invalid config for Telegram binding ${ctx.bindingId}: ${formatIssues(validated.issues)}`
        );
      }

      const config = validated.value;
      const token = ctx.secrets.get(config.botTokenSecret);

      if (token === undefined || token === "") {
        throw new Error(
          `Telegram binding ${ctx.bindingId} needs the secret ${config.botTokenSecret} in secrets.yaml`
        );
      }

      return createTelegramBinding(config, ctx, {
        client: await createClient(token),
      });
    },
    type: TELEGRAM_FRONTEND_TYPE,
  };
};

/** The built-in Telegram Frontend, for the built-in Frontends of `ExtensionCatalog`. */
export const telegramFrontend: Frontend = createTelegramFrontend();
