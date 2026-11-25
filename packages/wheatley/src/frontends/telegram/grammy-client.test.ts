import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { text } from "node:stream/consumers";

import { afterEach, expect, it } from "vitest";

import { TelegramApiError } from "./client.js";
import type { TelegramClient, TelegramUpdate } from "./client.js";
import { createGrammyClient } from "./grammy-client.js";

const TOKEN = "123456:test-token";
const BOT_PATH = `/bot${TOKEN}/`;
const FILE_PATH = `/file/bot${TOKEN}/`;
const POLL_WAIT_MS = 20;

interface RecordedCall {
  readonly method: string;
  readonly body: string;
}

/** Answers one Bot API method: a `result` for success, or a Bot API error response. */
type MethodReply =
  | { readonly result: unknown }
  | {
      readonly errorCode: number;
      readonly description: string;
      readonly retryAfter?: number;
    };

interface FakeBotApi {
  readonly apiRoot: string;
  readonly calls: RecordedCall[];
}

let servers: Server[] = [];

/** A Bot API response body. */
interface BotApiResponse {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly description?: string;
  readonly error_code?: number;
  readonly parameters?: { readonly retry_after: number };
}

const sendJson = (
  response: ServerResponse,
  status: number,
  body: BotApiResponse
): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

/** Starts a Bot API server on a free local port. `reply` answers each method call; `files` serves file downloads. */
const startBotApi = async (
  reply: (method: string, body: string) => MethodReply | Promise<MethodReply>,
  files: Readonly<Record<string, string>> = {}
): Promise<FakeBotApi> => {
  const calls: RecordedCall[] = [];

  const handle = async (
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> => {
    const url = request.url ?? "";

    if (url.startsWith(FILE_PATH)) {
      const content = files[url.slice(FILE_PATH.length)];
      response.writeHead(content === undefined ? 404 : 200);
      response.end(content);

      return;
    }

    const method = url.slice(BOT_PATH.length);
    const body = await text(request);
    calls.push({ body, method });
    const answer = await reply(method, body);

    if ("result" in answer) {
      sendJson(response, 200, { ok: true, result: answer.result });

      return;
    }

    sendJson(response, answer.errorCode, {
      description: answer.description,
      error_code: answer.errorCode,
      ok: false,
      parameters:
        answer.retryAfter === undefined
          ? undefined
          : { retry_after: answer.retryAfter },
    });
  };

  const server = createServer((request, response) => {
    void handle(request, response);
  });

  servers.push(server);
  const listening = Promise.withResolvers<undefined>();
  server.listen(0, "127.0.0.1", () => {
    listening.resolve(undefined);
  });
  await listening.promise;
  const address = server.address();

  if (!(address instanceof Object)) {
    throw new TypeError("The fake Bot API has no TCP address");
  }

  return { apiRoot: `http://127.0.0.1:${address.port}`, calls };
};

const sentMessage = (messageId: number) => ({
  chat: { id: 42, type: "private" },
  date: 0,
  message_id: messageId,
});

/** Returns the `TelegramApiError` that `promise` rejects with. Fails the test for any other outcome. */
const rejectionOf = async (
  promise: Promise<unknown>
): Promise<TelegramApiError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TelegramApiError) {
      return error;
    }

    throw error;
  }

  throw new Error("Expected a rejection");
};

afterEach(async () => {
  await Promise.all(
    servers.map(async (server) => {
      server.closeAllConnections();
      const closed = Promise.withResolvers<undefined>();
      server.close(() => {
        closed.resolve(undefined);
      });
      await closed.promise;
    })
  );
  servers = [];
});

it("sends a message to a forum topic and resolves with its message ID", async () => {
  const api = await startBotApi(() => ({ result: sentMessage(501) }));
  const client = await createGrammyClient(TOKEN, { apiRoot: api.apiRoot });

  const messageId = await client.sendMessage(
    { chatId: -100, threadId: 7 },
    "<b>hi</b>",
    {
      keyboard: [[{ callbackData: "ap:x:o", text: "Allow" }]],
      parseMode: "HTML",
    }
  );

  const [call] = api.calls;

  expect(messageId).toBe(501);
  expect(call?.method).toBe("sendMessage");
  expect(JSON.parse(call?.body ?? "{}")).toMatchObject({
    chat_id: -100,
    message_thread_id: 7,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[{ callback_data: "ap:x:o", text: "Allow" }]],
    },
    text: "<b>hi</b>",
  });
});

it("converts a Bot API error to a TelegramApiError with its code and retry wait", async () => {
  const api = await startBotApi(() => ({
    description: "Too Many Requests: retry after 3",
    errorCode: 429,
    retryAfter: 3,
  }));

  const client = await createGrammyClient(TOKEN, { apiRoot: api.apiRoot });

  const error = await rejectionOf(client.sendMessage({ chatId: 42 }, "hi"));

  expect(error).toMatchObject({
    code: 429,
    message: "Too Many Requests: retry after 3",
    retryAfterSeconds: 3,
  });
});

it("converts a network failure to a TelegramApiError without a code", async () => {
  const api = await startBotApi(() => ({ result: true }));
  const client = await createGrammyClient(TOKEN, { apiRoot: api.apiRoot });
  await Promise.all(
    servers.map(async (server) => {
      const closed = Promise.withResolvers<undefined>();
      server.close(() => {
        closed.resolve(undefined);
      });
      await closed.promise;
    })
  );
  servers = [];

  const error = await rejectionOf(client.sendTyping({ chatId: 42 }));

  expect(error).toMatchObject({
    code: undefined,
    retryAfterSeconds: undefined,
  });
});

it("uploads a photo with its file name and resolves with its message ID", async () => {
  const api = await startBotApi(() => ({ result: sentMessage(777) }));
  const client = await createGrammyClient(TOKEN, { apiRoot: api.apiRoot });

  const messageId = await client.sendFile({ chatId: 42 }, "photo", {
    data: new TextEncoder().encode("png-bytes"),
    filename: "chart.png",
  });

  const [call] = api.calls;

  expect(messageId).toBe(777);
  expect(call?.method).toBe("sendPhoto");
  expect(call?.body).toMatch(/filename="?chart\.png"?/u);
  expect(call?.body).toContain("png-bytes");
});

it("downloads a file through getFile", async () => {
  const api = await startBotApi(
    () => ({
      result: { file_id: "f1", file_path: "docs/a.txt", file_unique_id: "u1" },
    }),
    { "docs/a.txt": "hello file" }
  );

  const client = await createGrammyClient(TOKEN, { apiRoot: api.apiRoot });

  const chunks: Uint8Array[] = [];

  for await (const chunk of await client.downloadFile("f1")) {
    chunks.push(chunk);
  }

  expect(Buffer.concat(chunks).toString("utf-8")).toBe("hello file");
  expect(JSON.parse(api.calls[0]?.body ?? "{}")).toMatchObject({
    file_id: "f1",
  });
});

it("rejects a download with code 400 if Telegram returns no file path", async () => {
  const api = await startBotApi(() => ({
    result: { file_id: "f1", file_unique_id: "u1" },
  }));

  const client = await createGrammyClient(TOKEN, { apiRoot: api.apiRoot });

  const error = await rejectionOf(client.downloadFile("f1"));

  expect(error).toMatchObject({ code: 400 });
});

it("polls updates in order until stopPolling", async () => {
  const update: TelegramUpdate = {
    message: {
      chat: { id: 42, type: "private" },
      message_id: 1,
      text: "hi",
    },
    update_id: 10,
  };

  let delivered = false;

  const api = await startBotApi(async (method) => {
    if (method === "getMe") {
      return {
        result: {
          first_name: "Wheatley",
          id: 999,
          is_bot: true,
          username: "wheatley_bot",
        },
      };
    }

    if (method === "getUpdates" && !delivered) {
      delivered = true;

      return {
        result: [{ ...update, message: { ...update.message, date: 0 } }],
      };
    }

    if (method === "getUpdates") {
      const wait = Promise.withResolvers<undefined>();
      setTimeout(() => {
        wait.resolve(undefined);
      }, POLL_WAIT_MS);
      await wait.promise;

      return { result: [] };
    }

    return { result: true };
  });

  const client: TelegramClient = await createGrammyClient(TOKEN, {
    apiRoot: api.apiRoot,
  });

  const received = Promise.withResolvers<TelegramUpdate>();

  const polling = client.startPolling(async (incoming) => {
    await Promise.resolve();
    received.resolve(incoming);
  });

  const first = await received.promise;
  await client.stopPolling();
  await polling;

  expect(first).toMatchObject({ message: { text: "hi" }, update_id: 10 });
  expect(api.calls.map((call) => call.method)).toContain("deleteWebhook");
});
