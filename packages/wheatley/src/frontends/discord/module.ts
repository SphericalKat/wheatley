import type { Frontend, JsonValue } from "@wheatley/sdk";

import type { AgentModule, RpcHandlerMap } from "../../contracts/module.js";
import type { Migration } from "../../db/migrations.js";
import { DiscordBinding } from "./binding.js";
import type { DiscordFrontendOptions } from "./binding.js";
import { discordConfigSchema, parseDiscordConfig } from "./config.js";

/** The `type` of a Discord Frontend Binding in `config.yaml`. */
export const DISCORD_FRONTEND_TYPE = "discord";

/** The Discord Frontend keeps no tables in `agent.sqlite`. It stores Approval prompts in the binding's `dataDir`. */
export const discordMigrations: readonly Migration[] = [];

/** The Discord Frontend handles no JSON-RPC methods. Binding status comes from the Agent. */
export const discordRpcHandlers: RpcHandlerMap = {};

/**
 * Creates the built-in Discord Frontend (ADR 0012). `discord.js` loads only when a binding starts.
 *
 * `createBinding` throws if the config is invalid, for example with an empty `allowedChatIds` list, or if the secret
 * that `tokenSecret` names is not set.
 */
export const createDiscordFrontend = (
  options: DiscordFrontendOptions = {}
): Frontend => ({
  configSchema: discordConfigSchema,
  createBinding: (config: JsonValue, ctx) => {
    const parsed = parseDiscordConfig(config);
    const token = ctx.secrets.get(parsed.tokenSecret);

    if (token === undefined || token === "") {
      throw new Error(
        `Discord Frontend Binding ${ctx.bindingId} needs the secret ${parsed.tokenSecret}, which is not set`
      );
    }

    return new DiscordBinding(parsed, ctx, token, options);
  },
  type: DISCORD_FRONTEND_TYPE,
});

/** The built-in Discord Frontend with production defaults. */
export const discordFrontend: Frontend = createDiscordFrontend();

/**
 * The Agent module of the Discord Frontend. Its `api` is the `Frontend` that the Agent adds to the built-in Frontends
 * of its extensions. `deps` are the third-party seams; production wiring passes `{}`.
 */
export const discordFrontendModule: AgentModule<
  DiscordFrontendOptions,
  Frontend
> = {
  create: (_ctx, deps) => ({
    api: createDiscordFrontend(deps),
    rpc: discordRpcHandlers,
  }),
  migrations: discordMigrations,
  name: "frontend_discord",
  scope: "agent",
};
