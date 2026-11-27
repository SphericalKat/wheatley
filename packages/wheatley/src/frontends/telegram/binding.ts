import { randomBytes, timingSafeEqual } from "node:crypto";

import type {
  FrontendBinding,
  FrontendContext,
  FrontendSink,
  RunEvent,
  WebhookRequest,
  WebhookResponse,
  WebhookRoute,
} from "@wheatley-ai/sdk";
import { Value } from "typebox/value";

import { ApprovalPromptStore } from "./approvals.js";
import { createAllowlist, parseChatKey } from "./chat-key.js";
import { TelegramUpdateSchema } from "./client.js";
import type { BotIdentity, TelegramClient, TelegramUpdate } from "./client.js";
import type { TelegramConfig } from "./config.js";
import { createDeliverer } from "./delivery.js";
import { HTTP_BAD_REQUEST, HTTP_OK, HTTP_UNAUTHORIZED } from "./http-status.js";
import { createUpdateHandler } from "./inbound.js";
import { LiveRuns } from "./live.js";
import { createPickerStore } from "./model-picker.js";
import { RecentSet } from "./recent-set.js";
import { SerialQueue } from "./serial-queue.js";

/** The path suffix of the webhook route: `/frontends/<agent>/<binding-id>/updates`. */
export const WEBHOOK_PATH_SUFFIX = "updates";

/** The header that carries the secret token of `setWebhook`. */
export const SECRET_TOKEN_HEADER = "x-telegram-bot-api-secret-token";

/** How many webhook update IDs a binding remembers to drop duplicates. */
const DEDUP_CAPACITY = 1000;

const SECRET_TOKEN_BYTES = 32;

const tokensMatch = (given: string, expected: string): boolean => {
  const left = Buffer.from(given);
  const right = Buffer.from(expected);

  return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * Creates one Telegram Frontend Binding (ADRs 0007 and 0012).
 *
 * Throws if webhook mode is configured while the Webhook Ingress is disabled.
 */
export const createTelegramBinding = (
  config: TelegramConfig,
  ctx: FrontendContext,
  client: TelegramClient
): FrontendBinding => {
  const { log, registerWebhookRoute } = ctx;

  if (
    config.transport.mode === "webhook" &&
    registerWebhookRoute === undefined
  ) {
    throw new Error(
      `Telegram binding ${ctx.bindingId} uses webhook mode, but the Webhook Ingress is disabled`
    );
  }

  const isAllowed = createAllowlist(config.allowedChatIds);
  const approvals = new ApprovalPromptStore(ctx.dataDir);
  const pickers = createPickerStore(ctx.dataDir);

  const live = new LiveRuns(client, log, {
    draftIntervalMs: config.draftIntervalMs,
    streaming: config.streaming,
  });

  const deliver = createDeliverer({
    approvals,
    client,
    isAllowed,
    live,
    log,
    maxAttachmentBytes: ctx.maxAttachmentBytes,
    pickers,
  });

  const handle = createUpdateHandler({
    approvals,
    client,
    config,
    ctx,
    isAllowed,
    pickers,
  });

  const seenUpdates = new RecentSet<number>(DEDUP_CAPACITY);
  const webhookUpdates = new SerialQueue();
  const secretToken = randomBytes(SECRET_TOKEN_BYTES).toString("base64url");

  let sink: FrontendSink | undefined;
  let bot: BotIdentity | undefined;
  let polling: Promise<void> | undefined;
  let route: WebhookRoute | undefined;

  const handleUpdate = async (update: TelegramUpdate): Promise<void> => {
    if (sink !== undefined && bot !== undefined) {
      await handle(update, sink, bot);
    }
  };

  const onWebhook = async (
    request: WebhookRequest
  ): Promise<WebhookResponse> => {
    const given = request.headers[SECRET_TOKEN_HEADER];

    if (given === undefined || !tokensMatch(given, secretToken)) {
      return { status: HTTP_UNAUTHORIZED };
    }

    let update: unknown;

    try {
      update = JSON.parse(Buffer.from(request.body).toString("utf-8"));
    } catch {
      return { status: HTTP_BAD_REQUEST };
    }

    if (!Value.Check(TelegramUpdateSchema, update)) {
      return { status: HTTP_BAD_REQUEST };
    }

    if (!seenUpdates.has(update.update_id)) {
      seenUpdates.add(update.update_id);
      await webhookUpdates.run(async () => {
        await handleUpdate(update);
      });
    }

    return { status: HTTP_OK };
  };

  return {
    deliver,
    onEvent: (event: RunEvent): void => {
      const target = parseChatKey(event.chatId);

      if (target !== undefined && isAllowed(event.chatId)) {
        live.onEvent(event, target);
      }
    },
    start: async (activeSink: FrontendSink): Promise<void> => {
      await approvals.load();
      await pickers.load();
      bot = await client.getMe();
      sink = activeSink;

      try {
        await client.setMyCommands(
          activeSink.commands.map((command) => ({
            command: command.name,
            description:
              command.argument === undefined
                ? command.description
                : `${command.description} ${command.argument}`,
          }))
        );
      } catch (error) {
        log.warn("Failed to register Telegram bot commands", {
          error: String(error),
        });
      }

      if (
        config.transport.mode === "polling" ||
        registerWebhookRoute === undefined
      ) {
        polling = (async (): Promise<void> => {
          try {
            await client.startPolling(handleUpdate);
          } catch (error) {
            log.error("Telegram polling stopped", { error: String(error) });
          }
        })();

        return;
      }

      route = registerWebhookRoute(WEBHOOK_PATH_SUFFIX, onWebhook);
      await client.setWebhook(config.transport.url, secretToken);
      log.info("Telegram webhook registered", {
        route: route.path,
        url: config.transport.url,
      });
    },
    stop: async (): Promise<void> => {
      route?.unregister();
      route = undefined;
      live.stop();
      await client.stopPolling();
      await polling;
      await webhookUpdates.idle();
    },
  };
};
