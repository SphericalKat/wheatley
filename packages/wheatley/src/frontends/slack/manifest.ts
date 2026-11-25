import type { CommandSpec } from "@wheatley/sdk";
import { BUILTIN_COMMANDS } from "@wheatley/sdk";

/** The webhook path suffix of a binding in `webhook` transport. Events, commands, and interactions share it. */
export const WEBHOOK_PATH_SUFFIX = "events";

/** Slack limits a bot display name to 80 characters. */
const MAX_DISPLAY_NAME_LENGTH = 80;

/** The bot scopes that the binding uses. */
export const SLACK_BOT_SCOPES = [
  "channels:history",
  "chat:write",
  "commands",
  "files:read",
  "files:write",
  "groups:history",
  "im:history",
  "mpim:history",
  "reactions:write",
  "users:read",
] as const;

/** The message events that the binding subscribes to. */
export const SLACK_BOT_EVENTS = [
  "message.channels",
  "message.groups",
  "message.im",
  "message.mpim",
] as const;

/** Input of `createSlackAppManifest`. */
export type SlackManifestOptions = {
  /** The app and bot display name, for example the Agent name. */
  readonly appName: string;
  /** The Slash Commands. The default is the seven built-in commands (ADR 0012). */
  readonly commands?: readonly CommandSpec[];
} & (
  | { readonly transport: "socket" }
  | {
      readonly transport: "webhook";
      /** The public URL of the binding's webhook route, for example `https://example.com/frontends/home/slack/events`. */
      readonly requestUrl: string;
    }
);

/** One Slash Command of a Slack App manifest. */
export interface SlackManifestCommand {
  readonly command: string;
  readonly description: string;
  readonly should_escape: boolean;
  readonly usage_hint?: string;
  readonly url?: string;
}

/** The Slack App manifest fields that the binding needs. */
export interface SlackAppManifest {
  readonly display_information: { readonly name: string };
  readonly features: {
    readonly app_home: {
      readonly messages_tab_enabled: boolean;
      readonly messages_tab_read_only_enabled: boolean;
    };
    readonly bot_user: {
      readonly always_online: boolean;
      readonly display_name: string;
    };
    readonly slash_commands: readonly SlackManifestCommand[];
  };
  readonly oauth_config: {
    readonly scopes: { readonly bot: readonly string[] };
  };
  readonly settings: {
    readonly event_subscriptions: {
      readonly bot_events: readonly string[];
      readonly request_url?: string;
    };
    readonly interactivity: {
      readonly is_enabled: boolean;
      readonly request_url?: string;
    };
    readonly org_deploy_enabled: boolean;
    readonly socket_mode_enabled: boolean;
    readonly token_rotation_enabled: boolean;
  };
}

/**
 * Builds the Slack App manifest for a binding. The Operator pastes it at api.slack.com/apps, because Slack has no
 * bot-token API to register Slash Commands.
 *
 * The manifest declares every built-in command as a native Slash Command, the message events, the Approval button
 * interactivity, and the bot scopes. In `webhook` transport, events, commands, and interactions use `requestUrl`. In
 * `socket` transport, the URL fields are `undefined`, and `JSON.stringify` omits them.
 */
export const createSlackAppManifest = (
  options: SlackManifestOptions
): SlackAppManifest => {
  const commands: readonly CommandSpec[] = options.commands ?? BUILTIN_COMMANDS;

  const requestUrl =
    options.transport === "webhook" ? options.requestUrl : undefined;

  const name = options.appName.slice(0, MAX_DISPLAY_NAME_LENGTH);

  return {
    display_information: { name },
    features: {
      app_home: {
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: { always_online: true, display_name: name },
      slash_commands: commands.map((command) => ({
        command: `/${command.name}`,
        description: command.description,
        should_escape: false,
        usage_hint: command.argument,
        url: requestUrl,
      })),
    },
    oauth_config: { scopes: { bot: SLACK_BOT_SCOPES } },
    settings: {
      event_subscriptions: {
        bot_events: SLACK_BOT_EVENTS,
        request_url: requestUrl,
      },
      interactivity: { is_enabled: true, request_url: requestUrl },
      org_deploy_enabled: false,
      socket_mode_enabled: options.transport === "socket",
      token_rotation_enabled: false,
    },
  };
};
