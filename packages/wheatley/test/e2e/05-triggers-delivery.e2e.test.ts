// Flow 5 of issue #50: Trigger firing (manual, cron, once) and Webhook Ingress Bearer auth start Runs whose final
// replies go through the Delivery Outbox to a Frontend Binding, with retries, the failed-delivery list,
// copy-on-confirm into the target Chat, and `suppress_delivery`.
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  Context,
  FauxResponseFactory,
} from "@earendil-works/pi-ai";
import type { FailedDelivery, TriggerInput } from "@wheatley-ai/protocol";
import type { Delivery, MessageDelivery } from "@wheatley-ai/sdk";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, expect, it, vi } from "vitest";

import type { FakeBindingHandle } from "./fake-frontend.js";
import { startHarness, waitFor } from "./harness.js";
import type { Harness, HarnessOptions, RpcSession } from "./harness.js";

const AGENT = "home";
const BINDING = "fake-main";
const CHAT = "chat-1";
const TOKEN_SECRET = "HOOK_TOKEN";
const TOKEN = "s3cret-hook-token";
const ONE_MINUTE_MS = 60_000;

/** How far before a minute boundary the faked clock starts, so a `* * * * *` tick is due soon. */
const CRON_LEAD_MS = 1500;

/** How long a test waits after a suppressed Run before it checks that nothing was delivered. */
const SETTLE_MS = 300;

let harness: Harness | undefined;

afterEach(async () => {
  vi.useRealTimers();
  await harness?.cleanup();
  harness = undefined;
});

const start = async (options: HarnessOptions = {}): Promise<Harness> => {
  harness = await startHarness({
    agents: {
      [AGENT]: { frontends: [{ config: {}, id: BINDING, type: "fake" }] },
    },
    ...options,
  });

  return harness;
};

const isMessage = (delivery: Delivery): delivery is MessageDelivery =>
  delivery.kind === "message";

const messages = (binding: FakeBindingHandle): MessageDelivery[] =>
  binding.deliveries.filter(isMessage);

const waitForMessage = async (
  binding: FakeBindingHandle,
  text: string
): Promise<MessageDelivery> =>
  await waitFor(
    () => messages(binding).find((delivery) => delivery.text === text),
    `the delivery "${text}"`
  );

const triggerInput = (
  name: string,
  prompt: string,
  schedule: TriggerInput["schedule"]
): TriggerInput => ({
  name,
  prompt,
  schedule,
  target: { bindingId: BINDING, chatId: CHAT },
});

const CRON_EVERY_MINUTE: TriggerInput["schedule"] = {
  kind: "cron",
  schedule: "* * * * *",
  timezone: "UTC",
};

/** The text of every user message in a model request. */
const userTexts = (context: Context): string[] =>
  context.messages.flatMap((message) => {
    if (message.role !== "user") {
      return [];
    }

    return Array.isArray(message.content)
      ? message.content.flatMap((block) =>
          block.type === "text" ? [block.text] : []
        )
      : [message.content];
  });

/** A scripted reply that records the model request it answered. */
const recording = (
  seen: Context[],
  reply: () => AssistantMessage
): FauxResponseFactory => {
  const factory: FauxResponseFactory = (context) => {
    seen.push(structuredClone(context));

    return reply();
  };

  return factory;
};

const AddressSchema = Type.Object({ port: Type.Integer({ minimum: 1 }) });

/** The `202 Accepted` body of the Webhook Ingress. */
const AcceptedSchema = Type.Object(
  { eventId: Type.String({ minLength: 1 }) },
  { additionalProperties: false }
);

/** Resolves a TCP port that is free on 127.0.0.1 now. `webhooks.port` must be 1 or more. */
const freePort = async (): Promise<number> => {
  const server = createServer();

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const { port } = Value.Parse(AddressSchema, server.address());

  server.close();

  await once(server, "close");

  return port;
};

/** The failed deliveries of `agent`, or of every Agent. */
const listFailed = async (
  session: RpcSession,
  agent?: string
): Promise<FailedDelivery[]> => {
  const { deliveries } = await session.request(
    "deliveries.listFailed",
    agent === undefined ? {} : { agent }
  );

  return deliveries;
};

/** The ID of the Conversation of `CHAT`: the Conversation of a Memory archive hit for a unique word of the Chat. */
const chatConversationId = async (
  session: RpcSession,
  word: string
): Promise<string> => {
  const { hits } = await session.request("memory.search", {
    agent: AGENT,
    query: word,
    scope: "conversations",
  });

  const hit = hits.find((item) => item.kind === "conversation");

  if (hit?.kind !== "conversation") {
    throw new Error(`No archived Chat message contains ${word}`);
  }

  return hit.conversationId;
};

/** The Conversations whose archive holds `word`. */
const archivedIn = async (
  session: RpcSession,
  word: string
): Promise<string[]> => {
  const { hits } = await session.request("memory.search", {
    agent: AGENT,
    query: word,
    scope: "conversations",
  });

  return hits.flatMap((hit) =>
    hit.kind === "conversation" ? [hit.conversationId] : []
  );
};

/** Starts a Chat Conversation for `CHAT` with one exchange that contains `word`, and resolves its ID. */
const openChat = async (
  h: Harness,
  session: RpcSession,
  word: string
): Promise<string> => {
  const binding = h.frontend.binding(AGENT, BINDING);

  h.llm.faux.setResponses([fauxAssistantMessage(`Noted ${word}`)]);
  await h.frontend.send(AGENT, BINDING, CHAT, `Remember ${word}`, "Ada");
  await waitForMessage(binding, `Noted ${word}`);

  return await chatConversationId(session, word);
};

it("fires a cron Trigger on Operator request and delivers its reply to the target Chat", async () => {
  const h = await start();
  const session = await h.connect();
  const binding = h.frontend.binding(AGENT, BINDING);

  const { trigger } = await session.request("triggers.create", {
    agent: AGENT,
    trigger: triggerInput(
      "Morning",
      "Write the morning note",
      CRON_EVERY_MINUTE
    ),
  });

  expect(trigger).toMatchObject({
    conversationMode: "per_firing",
    createdBy: "operator",
    lastFiredAt: null,
    paused: false,
  });
  expect(Date.parse(trigger.nextFireAt ?? "")).toBeGreaterThan(Date.now());

  const seen: Context[] = [];

  h.llm.faux.setResponses([
    recording(seen, () =>
      fauxAssistantMessage("Good morning from the Trigger")
    ),
  ]);

  const { runId } = await session.request("triggers.fire", {
    agent: AGENT,
    triggerId: trigger.id,
  });

  const delivered = await waitForMessage(
    binding,
    "Good morning from the Trigger"
  );

  expect(delivered).toMatchObject({
    chatId: CHAT,
    kind: "message",
    runId,
    source: "trigger",
  });
  expect(userTexts(seen[0] ?? { messages: [] })).toContain(
    "Write the morning note"
  );

  const finished = await session.waitForEvent(
    "run.finished",
    (payload) => payload.run.runId === runId
  );

  expect(finished.run).toMatchObject({
    origin: { kind: "trigger", triggerId: trigger.id },
    status: "completed",
  });

  const fired = await session.waitForEvent(
    "trigger.changed",
    (payload) => payload.change === "fired" && payload.triggerId === trigger.id
  );

  expect(fired.trigger?.lastFiredAt).not.toBeNull();

  const { triggers } = await session.request("triggers.list", { agent: AGENT });

  expect(triggers).toHaveLength(1);
  expect(triggers[0]?.lastFiredAt).not.toBeNull();
  expect(triggers[0]?.nextFireAt).toBe(trigger.nextFireAt);
});

it("fires a cron Trigger on its schedule", async () => {
  const h = await start();
  const session = await h.connect();
  const binding = h.frontend.binding(AGENT, BINDING);

  // Only `Date` is faked, and it keeps advancing with real time, so the next minute boundary is due in 1.5 seconds.
  const boundary =
    Math.ceil((Date.now() + ONE_MINUTE_MS) / ONE_MINUTE_MS) * ONE_MINUTE_MS;

  vi.useFakeTimers({
    now: boundary - CRON_LEAD_MS,
    shouldAdvanceTime: true,
    toFake: ["Date"],
  });

  h.llm.faux.setResponses([fauxAssistantMessage("Tick from cron")]);

  const { trigger } = await session.request("triggers.create", {
    agent: AGENT,
    trigger: triggerInput("Every minute", "Report the tick", CRON_EVERY_MINUTE),
  });

  expect(trigger.nextFireAt).toBe(new Date(boundary).toISOString());

  const delivered = await waitForMessage(binding, "Tick from cron");

  expect(delivered.source).toBe("trigger");

  const fired = await session.waitForEvent(
    "trigger.changed",
    (payload) => payload.change === "fired" && payload.triggerId === trigger.id
  );

  expect(Date.parse(fired.trigger?.nextFireAt ?? "")).toBe(
    boundary + ONE_MINUTE_MS
  );
});

it("fires a once Trigger that the Agent scheduled from a Chat and delivers to that Chat", async () => {
  const h = await start();
  const session = await h.connect();
  const binding = h.frontend.binding(AGENT, BINDING);

  h.llm.faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("schedule_trigger", {
          name: "Tea",
          prompt: "Remind the user about the tea",
          schedule: { delay: "1s", kind: "once" },
        }),
      ],
      { stopReason: "toolUse" }
    ),
    fauxAssistantMessage("I will remind you."),
    fauxAssistantMessage("Your tea is ready"),
  ]);

  await h.frontend.send(AGENT, BINDING, CHAT, "Remind me in a second", "Ada");

  const reminder = await waitForMessage(binding, "Your tea is ready");

  expect(reminder).toMatchObject({ chatId: CHAT, source: "trigger" });
  expect(messages(binding).map((delivery) => delivery.text)).toEqual([
    "I will remind you.",
    "Your tea is ready",
  ]);

  const { triggers } = await session.request("triggers.list", { agent: AGENT });

  expect(triggers).toEqual([
    expect.objectContaining({
      createdBy: "agent",
      name: "Tea",
      nextFireAt: null,
      target: { bindingId: BINDING, chatId: CHAT },
    }),
  ]);
  expect(triggers[0]?.lastFiredAt).not.toBeNull();
});

it("accepts a webhook only with the Bearer token and delivers the Run reply", async () => {
  const port = await freePort();

  const h = await start({
    config: { webhooks: { enabled: true, host: "127.0.0.1", port } },
    secrets: { [TOKEN_SECRET]: TOKEN },
  });

  const session = await h.connect();
  const binding = h.frontend.binding(AGENT, BINDING);

  const { trigger } = await session.request("triggers.create", {
    agent: AGENT,
    trigger: triggerInput("Deploys", "Summarize the deploy event", {
      kind: "webhook",
      tokenSecret: TOKEN_SECRET,
    }),
  });

  const url = `http://127.0.0.1:${port}/webhooks/${AGENT}/${trigger.id}`;
  const body = JSON.stringify({ service: "api", status: "green" });

  const bearer = { authorization: `Bearer ${TOKEN}` };

  const post = async (
    target: string,
    headers: Record<string, string>
  ): Promise<Response> =>
    await fetch(target, {
      body,
      headers: { "content-type": "application/json", ...headers },
      method: "POST",
    });

  const statusOf = async (
    target: string,
    headers: Record<string, string>
  ): Promise<number> => {
    const response = await post(target, headers);

    return response.status;
  };

  const getResponse = await fetch(url, { method: "GET" });

  expect(await statusOf(url, {})).toBe(401);
  expect(await statusOf(url, { authorization: "Bearer wrong-token" })).toBe(
    401
  );
  expect(await statusOf(url, { authorization: TOKEN })).toBe(401);
  expect(
    await statusOf(
      `http://127.0.0.1:${port}/webhooks/${AGENT}/no-such-trigger`,
      bearer
    )
  ).toBe(404);
  expect(
    await statusOf(
      `http://127.0.0.1:${port}/webhooks/nobody/${trigger.id}`,
      bearer
    )
  ).toBe(404);
  expect(getResponse.status).toBe(405);
  expect(binding.deliveries).toEqual([]);

  const seen: Context[] = [];

  h.llm.faux.setResponses([
    recording(seen, () => fauxAssistantMessage("Deploy api is green")),
  ]);

  const accepted = await post(url, bearer);
  const acceptedBody: unknown = await accepted.json();

  expect(accepted.status).toBe(202);
  expect(Value.Check(AcceptedSchema, acceptedBody)).toBe(true);

  const delivered = await waitForMessage(binding, "Deploy api is green");

  expect(delivered).toMatchObject({ chatId: CHAT, source: "trigger" });
  expect(messages(binding)).toHaveLength(1);

  const prompt = userTexts(seen[0] ?? { messages: [] }).join("\n");

  expect(prompt).toContain("Summarize the deploy event");
  expect(prompt).toContain(body);
  expect(prompt).not.toContain(TOKEN);

  await session.request("triggers.update", {
    agent: AGENT,
    patch: { paused: true },
    triggerId: trigger.id,
  });

  expect(await statusOf(url, bearer)).toBe(404);
});

it("lists a permanently failed delivery, copies it into the Chat only after a retry confirms it, and dismisses another", async () => {
  const h = await start();
  const session = await h.connect();
  const binding = h.frontend.binding(AGENT, BINDING);
  const chatConversation = await openChat(h, session, "quokkaopen");

  const { trigger } = await session.request("triggers.create", {
    agent: AGENT,
    trigger: triggerInput("Digest", "Write the digest", CRON_EVERY_MINUTE),
  });

  h.frontend.failDeliveries(AGENT, BINDING, { kind: "permanent" });
  h.llm.faux.setResponses([fauxAssistantMessage("Digest zebrafjord ready")]);

  const { runId } = await session.request("triggers.fire", {
    agent: AGENT,
    triggerId: trigger.id,
  });

  const failed = await session.waitForEvent(
    "delivery.failed",
    (payload) => payload.delivery.preview === "Digest zebrafjord ready"
  );

  expect(failed).toMatchObject({
    agent: AGENT,
    delivery: {
      agent: AGENT,
      attempts: 1,
      bindingId: BINDING,
      chatId: CHAT,
      kind: "message",
      lastError: "The fake transport failed",
      permanent: true,
    },
  });

  const { deliveryId } = failed.delivery;

  expect(await listFailed(session, AGENT)).toEqual([failed.delivery]);
  const everyAgent = await listFailed(session);

  expect(everyAgent.map((delivery) => delivery.deliveryId)).toEqual([
    deliveryId,
  ]);

  // The Run archived its reply in the Trigger Conversation, but no copy reached the Chat Conversation yet.
  const triggerRun = await session.waitForEvent(
    "run.finished",
    (payload) => payload.run.runId === runId
  );

  expect(triggerRun.run.conversationId).not.toBe(chatConversation);
  expect(await archivedIn(session, "zebrafjord")).not.toContain(
    chatConversation
  );
  expect(messages(binding).map((delivery) => delivery.text)).toEqual([
    "Noted quokkaopen",
  ]);

  expect(
    await session.request("deliveries.retry", { agent: AGENT, deliveryId })
  ).toEqual({ requeued: true });

  const retried = await waitForMessage(binding, "Digest zebrafjord ready");

  expect(retried).toMatchObject({
    messageId: deliveryId,
    runId,
    source: "trigger",
  });
  await session.waitForEvent(
    "delivery.cleared",
    (payload) =>
      payload.deliveryId === deliveryId && payload.reason === "retried"
  );
  expect(await listFailed(session, AGENT)).toEqual([]);

  const copies = await waitFor(async () => {
    const conversations = await archivedIn(session, "zebrafjord");

    return conversations.includes(chatConversation) ? conversations : undefined;
  }, "the copy of the delivered Trigger result in the Chat Conversation");

  expect(copies).toContain(triggerRun.run.conversationId);
  expect(
    await session.request("deliveries.retry", { agent: AGENT, deliveryId })
  ).toEqual({ requeued: false });

  h.frontend.failDeliveries(AGENT, BINDING, { kind: "permanent" });
  h.llm.faux.setResponses([fauxAssistantMessage("Second wombatdusk digest")]);
  await session.request("triggers.fire", {
    agent: AGENT,
    triggerId: trigger.id,
  });

  const second = await session.waitForEvent(
    "delivery.failed",
    (payload) => payload.delivery.preview === "Second wombatdusk digest"
  );

  expect(
    await session.request("deliveries.dismiss", {
      agent: AGENT,
      deliveryId: second.delivery.deliveryId,
    })
  ).toEqual({ dismissed: true });
  await session.waitForEvent(
    "delivery.cleared",
    (payload) =>
      payload.deliveryId === second.delivery.deliveryId &&
      payload.reason === "dismissed"
  );
  expect(await listFailed(session, AGENT)).toEqual([]);
  expect(
    await session.request("deliveries.retry", {
      agent: AGENT,
      deliveryId: second.delivery.deliveryId,
    })
  ).toEqual({ requeued: false });
  expect(await archivedIn(session, "wombatdusk")).not.toContain(
    chatConversation
  );
  expect(
    messages(binding).some((delivery) => delivery.text.includes("wombatdusk"))
  ).toBe(false);
});

it("retries a retryable delivery failure with backoff until the binding confirms it", async () => {
  const h = await start();
  const session = await h.connect();
  const binding = h.frontend.binding(AGENT, BINDING);

  const { trigger } = await session.request("triggers.create", {
    agent: AGENT,
    trigger: triggerInput("Flaky", "Write the flaky note", CRON_EVERY_MINUTE),
  });

  h.frontend.failDeliveries(AGENT, BINDING, { kind: "retryable", times: 2 });
  h.llm.faux.setResponses([fauxAssistantMessage("Flaky note arrived")]);
  await session.request("triggers.fire", {
    agent: AGENT,
    triggerId: trigger.id,
  });

  const delivered = await waitForMessage(binding, "Flaky note arrived");

  expect(delivered.source).toBe("trigger");
  expect(messages(binding)).toHaveLength(1);
  expect(session.events.some((event) => event.name === "delivery.failed")).toBe(
    false
  );
  expect(await listFailed(session, AGENT)).toEqual([]);
});

it("puts a confirmed Trigger result into the context of the next Run in the target Chat", async () => {
  const h = await start();
  const session = await h.connect();
  const binding = h.frontend.binding(AGENT, BINDING);

  await openChat(h, session, "lemurgate");

  const { trigger } = await session.request("triggers.create", {
    agent: AGENT,
    trigger: triggerInput("Parcel", "Check the parcel", CRON_EVERY_MINUTE),
  });

  h.llm.faux.setResponses([
    fauxAssistantMessage("Parcel narwhalbox arrives Friday"),
  ]);
  await session.request("triggers.fire", {
    agent: AGENT,
    triggerId: trigger.id,
  });
  await waitForMessage(binding, "Parcel narwhalbox arrives Friday");
  await waitFor(async () => {
    const conversations = await archivedIn(session, "narwhalbox");

    return conversations.length >= 2 ? true : undefined;
  }, "the copy of the Trigger result");

  const seen: Context[] = [];

  h.llm.faux.setResponses([
    recording(seen, () => fauxAssistantMessage("It arrives Friday.")),
  ]);
  await h.frontend.send(AGENT, BINDING, CHAT, "When does my parcel arrive?");
  await waitForMessage(binding, "It arrives Friday.");

  expect(JSON.stringify(seen[0]?.messages)).toContain(
    "Parcel narwhalbox arrives Friday"
  );
});

it("does not deliver the reply of a Trigger Run that calls suppress_delivery", async () => {
  const h = await start();
  const session = await h.connect();
  const binding = h.frontend.binding(AGENT, BINDING);

  const { trigger } = await session.request("triggers.create", {
    agent: AGENT,
    trigger: triggerInput("Quiet", "Check quietly", CRON_EVERY_MINUTE),
  });

  h.llm.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("suppress_delivery", {})], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Nothing to report"),
  ]);

  const suppressed = await session.request("triggers.fire", {
    agent: AGENT,
    triggerId: trigger.id,
  });

  const suppressCall = await session.waitForEvent(
    "run.toolFinished",
    (payload) =>
      payload.runId === suppressed.runId &&
      payload.toolName === "suppress_delivery"
  );

  expect(suppressCall.isError).toBe(false);

  const finished = await session.waitForEvent(
    "run.finished",
    (payload) => payload.run.runId === suppressed.runId
  );

  expect(finished.run.status).toBe("completed");

  // The outbox delivers one Chat in FIFO order, so the next delivery proves that nothing was queued before it.
  h.llm.faux.setResponses([fauxAssistantMessage("Loud report")]);
  await session.request("triggers.fire", {
    agent: AGENT,
    triggerId: trigger.id,
  });
  await waitForMessage(binding, "Loud report");
  await delay(SETTLE_MS);

  expect(messages(binding).map((delivery) => delivery.text)).toEqual([
    "Loud report",
  ]);

  h.llm.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("suppress_delivery", {})], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Chat reply stays"),
  ]);
  await h.frontend.send(AGENT, BINDING, CHAT, "Try to stay quiet");
  await waitForMessage(binding, "Chat reply stays");

  const chatCall = await session.waitForEvent(
    "run.toolFinished",
    (payload) =>
      payload.toolName === "suppress_delivery" &&
      payload.runId !== suppressed.runId
  );

  expect(chatCall.isError).toBe(true);
  expect(chatCall.outputPreview).toContain(
    "only in a Run that a Trigger started"
  );
});
