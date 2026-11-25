import type {
  AppsConnectionsOpenResponse,
  AuthTestResponse,
  ChatPostMessageArguments,
  ChatPostMessageResponse,
  ChatUpdateArguments,
  ChatUpdateResponse,
  FilesUploadV2Arguments,
  ReactionsAddArguments,
  ReactionsAddResponse,
  ReactionsRemoveArguments,
  ReactionsRemoveResponse,
  LogLevel as SlackLogLevel,
  Logger as SlackLogger,
  UsersInfoArguments,
  UsersInfoResponse,
  WebAPICallResult,
} from "@slack/web-api";
import type { Logger } from "@wheatley-ai/sdk";

import type { SlackBlocks } from "./approval-blocks.js";
import type { SlackChatTarget } from "./chat-id.js";

/**
 * The part of the `@slack/web-api` `WebClient` that the binding uses.
 *
 * Each method makes one Slack call with no automatic retry. A method rejects with a `@slack/web-api` error: a
 * platform error, a rate-limit error, an HTTP error, or a request error. `toDeliveryError` classifies these errors by
 * their `code`.
 */
export interface SlackWebClient {
  readonly auth: {
    readonly test: () => Promise<Pick<AuthTestResponse, "user_id">>;
  };
  readonly chat: {
    readonly postMessage: (
      args: ChatPostMessageArguments
    ) => Promise<Pick<ChatPostMessageResponse, "ts">>;
    readonly update: (
      args: ChatUpdateArguments
    ) => Promise<Pick<ChatUpdateResponse, "ok">>;
  };
  readonly reactions: {
    readonly add: (
      args: ReactionsAddArguments
    ) => Promise<Pick<ReactionsAddResponse, "ok">>;
    readonly remove: (
      args: ReactionsRemoveArguments
    ) => Promise<Pick<ReactionsRemoveResponse, "ok">>;
  };
  readonly users: {
    readonly info: (
      args: UsersInfoArguments
    ) => Promise<Pick<UsersInfoResponse, "user">>;
  };
  readonly filesUploadV2: (
    args: FilesUploadV2Arguments
  ) => Promise<Pick<WebAPICallResult, "ok">>;
}

/** One Socket Mode envelope, as the `@slack/socket-mode` client emits it on `slack_event`. */
export interface SlackSocketEnvelope {
  /** `events_api`, `slash_commands`, or `interactive`. */
  readonly type: string;
  readonly body: unknown;
  /** Acknowledges the envelope, so Slack does not deliver it again. */
  readonly ack: () => Promise<void>;
}

/** The part of the `@slack/socket-mode` `SocketModeClient` that the binding uses. */
export interface SlackSocketClient {
  /**
   * Adds a listener for envelopes. Call it before `start`, because the client emits envelopes as soon as it
   * connects. The listener must not throw: the client calls it synchronously from its event emitter.
   */
  readonly on: (
    event: "slack_event",
    listener: (envelope: SlackSocketEnvelope) => void
  ) => void;
  /**
   * Opens the first connection. After that, the client reconnects by itself until `disconnect`. Rejects with a
   * `@slack/web-api` error if Slack refuses the app token or the first connection fails.
   */
  readonly start: () => Promise<Pick<AppsConnectionsOpenResponse, "ok">>;
  /** Closes the connection and stops reconnects. Can reject. The binding logs the rejection and continues to stop. */
  readonly disconnect: () => Promise<void>;
}

/** Creates Slack clients. The default implementation loads the Slack packages on first use (ADR 0012). */
export interface SlackSdk {
  /** Creates a Web API client that logs to `log` and makes no automatic retries. Makes no Slack call. Never throws. */
  readonly createWebClient: (botToken: string, log: Logger) => SlackWebClient;
  /** Creates a Socket Mode client that logs to `log`. It does not connect until `start`. Never throws. */
  readonly createSocketClient: (
    appToken: string,
    log: Logger
  ) => SlackSocketClient;
}

/** The binding gets no automatic retries from the Slack client, because the Agent outbox retries deliveries. */
const WEB_CLIENT_RETRIES = 0;

const toText = (parts: readonly string[]): string => parts.join(" ");

/**
 * Forwards Slack client logs to the binding logger. Slack `info` logs report routine reconnects, so they go to
 * `debug`.
 */
const createSlackLogger = (
  log: Logger,
  initialLevel: SlackLogLevel
): SlackLogger => {
  let level = initialLevel;
  let prefix = "";

  const format = (parts: readonly string[]): string =>
    `${prefix}${toText(parts)}`;

  return {
    debug: (...parts: string[]) => {
      log.debug(format(parts));
    },
    error: (...parts: string[]) => {
      log.error(format(parts));
    },
    getLevel: () => level,
    info: (...parts: string[]) => {
      log.debug(format(parts));
    },
    setLevel: (next: SlackLogLevel) => {
      level = next;
    },
    setName: (name: string) => {
      prefix = `${name}: `;
    },
    warn: (...parts: string[]) => {
      log.warn(format(parts));
    },
  };
};

/** Loads `@slack/web-api` and `@slack/socket-mode` with dynamic imports, so Agents without Slack never load them. */
export const loadSlackSdk = async (): Promise<SlackSdk> => {
  const [webApi, socketMode] = await Promise.all([
    import("@slack/web-api"),
    import("@slack/socket-mode"),
  ]);

  return {
    createSocketClient: (appToken, log) =>
      new socketMode.SocketModeClient({
        appToken,
        logger: createSlackLogger(log, webApi.LogLevel.INFO),
      }),
    createWebClient: (botToken, log) =>
      new webApi.WebClient(botToken, {
        logger: createSlackLogger(log, webApi.LogLevel.INFO),
        rejectRateLimitedCalls: true,
        retryConfig: { retries: WEB_CLIENT_RETRIES },
      }),
  };
};

/** The content of a posted message: Markdown, or fallback text with optional Block Kit blocks. */
export type PostContent =
  | { readonly markdown_text: string }
  | {
      readonly text: string;
      readonly blocks?: SlackBlocks;
    };

/** Posts a message into a Chat, in its thread if the Chat is a thread. Returns the message `ts`. */
export const postToChat = async (
  client: SlackWebClient,
  target: SlackChatTarget,
  content: PostContent
): Promise<string | undefined> => {
  const args: ChatPostMessageArguments =
    target.threadTs === undefined
      ? { channel: target.channel, ...content }
      : { channel: target.channel, thread_ts: target.threadTs, ...content };

  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- This is Slack chat.postMessage, not window.postMessage.
  const posted = await client.chat.postMessage(args);

  return posted.ts;
};
