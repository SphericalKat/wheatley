import type { Frontend } from "@wheatley-ai/sdk";

import type { AgentModule, RpcHandlerMap } from "../../contracts/module.js";
import type { Migration } from "../../db/migrations.js";
import type { FetchFunction } from "./attachments.js";
import { SlackBinding } from "./binding.js";
import type { SlackBindingDeps } from "./binding.js";
import { parseSlackConfig, SLACK_CONFIG_SCHEMA } from "./config.js";
import { loadSlackSdk } from "./slack-client.js";
import type { SlackSdk } from "./slack-client.js";

/** The `type` of Slack entries in `frontends` of `config.yaml`. */
export const SLACK_FRONTEND_TYPE = "slack";

/** The third-party boundaries of the Slack Frontend. Each option defaults to the real boundary. */
export interface SlackFrontendOptions {
  /** Loads the Slack clients. The default imports `@slack/web-api` and `@slack/socket-mode` on first use. */
  readonly loadSdk?: () => Promise<SlackSdk>;
  /** Downloads inbound files. The default is the global `fetch`. */
  readonly fetch?: FetchFunction;
  /** Epoch milliseconds, for webhook signature timestamps. The default is `Date.now`. */
  readonly now?: () => number;
}

const defaultFetch: FetchFunction = async (url, init) =>
  await fetch(url, { headers: init.headers });

/**
 * Creates the built-in Slack Frontend (ADR 0007, ADR 0012).
 *
 * `createBinding` validates the config and resolves its secrets. It throws for an empty `allowedChatIds`, a missing
 * secret, or `webhook` transport while the Webhook Ingress is disabled. It loads no Slack package: `start` does that.
 */
export const createSlackFrontend = (
  options: SlackFrontendOptions = {}
): Frontend => {
  const deps: SlackBindingDeps = {
    fetch: options.fetch ?? defaultFetch,
    loadSdk: options.loadSdk ?? loadSlackSdk,
    now: options.now ?? Date.now,
  };

  return {
    configSchema: SLACK_CONFIG_SCHEMA,
    createBinding: (config, ctx) =>
      new SlackBinding(parseSlackConfig(config, ctx.secrets), ctx, deps),
    type: SLACK_FRONTEND_TYPE,
  };
};

/** The Slack Frontend keeps its state in `FrontendContext.dataDir` and has no `agent.sqlite` tables. */
export const slackMigrations: readonly Migration[] = [];

/** The Slack Frontend serves no JSON-RPC methods. */
export const slackRpcHandlers: RpcHandlerMap = {};

/**
 * The Agent module of the Slack Frontend. Its `api` is the `Frontend` of the `slack` type, for
 * `AgentExtensions.frontends`.
 */
export const slackFrontendModule: AgentModule<undefined, Frontend> = {
  create: () => ({ api: createSlackFrontend(), rpc: slackRpcHandlers }),
  migrations: slackMigrations,
  name: "frontend_slack",
  scope: "agent",
};
