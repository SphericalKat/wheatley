// Flow 3 of issue #50: Memory write, FTS5 search, the frozen MEMORY.md snapshot in the Conversation instructions,
// its refresh after /compact, and the Memory flush turn before a compaction.
import { readFile } from "node:fs/promises";
import path from "node:path";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type {
  FauxResponseFactory,
  Message,
  TextContent,
} from "@earendil-works/pi-ai";
import type { MessageDelivery } from "@wheatley-ai/sdk";
import { afterEach, expect, it } from "vitest";

import type { FakeBindingHandle } from "./fake-frontend.js";
import { startHarness, waitFor } from "./harness.js";
import type { Harness } from "./harness.js";

const AGENT = "home";
const BINDING = "fake-main";
const CHAT = "chat-1";

/** The first line of the Memory flush prompt (`compactionFlushPrompt` of the Markdown Memory store). */
const FLUSH_MARKER = "This Conversation compacts next";

/** The marker of the summary request that pi-durable sends to the model. */
const SUMMARY_MARKER = "<conversation>";

const SUMMARY_TEXT =
  "Summary: the user talked about colors, a cat, and Lisbon.";

/** Characters of one large Chat message: about 8,000 tokens for the fake LLM. */
const LARGE_MESSAGE_CHARS = 32_000;

/** A context window that makes pi-durable compact automatically after a few large messages. */
const SMALL_CONTEXT_WINDOW = 40_000;

/**
 * Padding of the turns before /compact: about 12,000 tokens each for the fake LLM. pi-durable keeps the newest 20,000
 * tokens verbatim, so without it a manual compaction has nothing to summarize.
 */
const PADDING = `\n${"x".repeat(48_000)}`;

/** Enough copies of the routing factory for every model request of one test. */
const SCRIPTED_REQUESTS = 60;

const INITIAL_MEMORY = "The user's favorite color is teal.";
const TURN_FACT = "The user owns a cat named Biscuit.";
const FLUSH_FACT = "The user has a dentist visit on Tuesday.";
const TRAVEL_NOTE = "Trip to Lisbon in May with a stop in Porto.";

/** One model request as the fake LLM saw it. */
interface ModelRequest {
  /** Every system message of the request, joined: the Conversation instructions. */
  readonly system: string;
  readonly last: Message | undefined;
  readonly lastText: string;
}

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

type ContentBlock = Exclude<Message["content"], string>[number];

const isTextBlock = (block: ContentBlock): block is TextContent =>
  block.type === "text";

const textOf = (content: Message["content"]): string =>
  Array.isArray(content)
    ? content
        .filter(isTextBlock)
        .map((block) => block.text)
        .join("")
    : content;

const messageText = (message: Message | undefined): string => {
  if (message === undefined) {
    return "";
  }

  if (message.role === "system") {
    return [
      textOf(message.content),
      ...Object.values(message.sections ?? {}).filter(
        (section): section is string => section !== null
      ),
    ].join("\n");
  }

  return textOf(message.content);
};

/**
 * A fake LLM that answers by the shape of each request and records it:
 * - a summary request gets `SUMMARY_TEXT`;
 * - the flush prompt gets a `memory_write` of `FLUSH_FACT` into MEMORY.md;
 * - "remember" gets `memory_write` calls for MEMORY.md and the `travel` topic file;
 * - "look up" gets a `memory_search` call;
 * - a Tool result gets a closing text;
 * - anything else gets "ok".
 */
const createRouter = () => {
  const requests: ModelRequest[] = [];

  const respond: FauxResponseFactory = (context) => {
    const last = context.messages.at(-1);
    const lastText = messageText(last);

    requests.push({
      last,
      lastText,
      system: context.messages
        .filter((message) => message.role === "system")
        .map(messageText)
        .join("\n"),
    });

    if (last?.role === "toolResult") {
      return fauxAssistantMessage(`tool said: ${lastText}`);
    }

    if (lastText.includes(SUMMARY_MARKER)) {
      return fauxAssistantMessage(SUMMARY_TEXT);
    }

    if (lastText.startsWith(FLUSH_MARKER)) {
      return fauxAssistantMessage(
        fauxToolCall("memory_write", {
          content: FLUSH_FACT,
          mode: "append",
          name: "MEMORY",
        }),
        { stopReason: "toolUse" }
      );
    }

    if (lastText.startsWith("remember")) {
      return fauxAssistantMessage(
        [
          fauxToolCall("memory_write", {
            content: TURN_FACT,
            mode: "append",
            name: "MEMORY",
          }),
          fauxToolCall("memory_write", {
            content: TRAVEL_NOTE,
            name: "travel",
          }),
        ],
        { stopReason: "toolUse" }
      );
    }

    if (lastText.startsWith("look up")) {
      return fauxAssistantMessage(
        fauxToolCall("memory_search", { query: "Lisbon" }),
        { stopReason: "toolUse" }
      );
    }

    return fauxAssistantMessage("ok");
  };

  return {
    requests,
    responses: Array.from({ length: SCRIPTED_REQUESTS }, () => respond),
  };
};

const replies = (binding: FakeBindingHandle): MessageDelivery[] =>
  binding.deliveries.filter(
    (delivery): delivery is MessageDelivery =>
      delivery.kind === "message" && delivery.chatId === CHAT
  );

const deliveryText = (delivery: MessageDelivery | undefined): string =>
  delivery?.text ?? "";

/** Sends one Chat message and waits for the next reply delivery. Returns the model requests of that turn. */
const turn = async (
  h: Harness,
  router: ReturnType<typeof createRouter>,
  text: string
): Promise<{ readonly reply: string; readonly requests: ModelRequest[] }> => {
  const binding = h.frontend.binding(AGENT, BINDING);
  const before = replies(binding).length;
  const firstRequest = router.requests.length;

  await h.frontend.send(AGENT, BINDING, CHAT, text, "Ada");

  const reply = await waitFor(
    () => replies(binding)[before],
    `the reply to "${text.slice(0, 20)}"`
  );

  return {
    reply: deliveryText(reply),
    requests: router.requests.slice(firstRequest),
  };
};

const memoryFile = (h: Harness, name: string): string =>
  path.join(h.agentDir(AGENT), "memory", `${name}.md`);

const startMemoryHarness = async (contextWindow?: number): Promise<Harness> =>
  await startHarness({
    agents: {
      [AGENT]: {
        frontends: [
          { config: { allowedChatIds: [CHAT] }, id: BINDING, type: "fake" },
        ],
      },
    },
    llm: contextWindow === undefined ? undefined : { contextWindow },
  });

it("writes Memory, finds it with FTS5, freezes MEMORY.md per Conversation, and refreshes it after /compact", async () => {
  const h = await startMemoryHarness();

  harness = h;

  const router = createRouter();
  const session = await h.connect();

  h.llm.faux.setResponses(router.responses);

  // An Operator write through JSON-RPC lands in MEMORY.md on disk before the Conversation starts.
  await session.request("memory.write", {
    agent: AGENT,
    content: INITIAL_MEMORY,
    name: "MEMORY",
  });
  await expect(readFile(memoryFile(h, "MEMORY"), "utf-8")).resolves.toContain(
    INITIAL_MEMORY
  );

  // The first turn starts the Conversation: its instructions carry the MEMORY.md snapshot of that moment.
  const first = await turn(
    h,
    router,
    `remember my cat and my Lisbon trip${PADDING}`
  );

  expect(first.requests.length).toBeGreaterThanOrEqual(2);
  expect(first.requests[0]?.system).toContain(INITIAL_MEMORY);
  expect(first.requests[0]?.system).not.toContain(TURN_FACT);

  // The memory_write Tool calls of the model wrote both files and emitted memory.changed.
  await session.waitForEvent(
    "memory.changed",
    (payload) => payload.change === "written" && payload.name === "travel"
  );

  const memoryAfterTurn = await readFile(memoryFile(h, "MEMORY"), "utf-8");

  expect(memoryAfterTurn).toContain(INITIAL_MEMORY);
  expect(memoryAfterTurn).toContain(TURN_FACT);
  await expect(readFile(memoryFile(h, "travel"), "utf-8")).resolves.toBe(
    TRAVEL_NOTE
  );

  // FTS5 search over JSON-RPC finds the topic file and the archived user message.
  const fileHits = await session.request("memory.search", {
    agent: AGENT,
    query: "Porto",
    scope: "memory",
  });

  expect(fileHits.hits).toEqual([
    expect.objectContaining({ kind: "memory", name: "travel" }),
  ]);

  const archiveHits = await session.request("memory.search", {
    agent: AGENT,
    query: "Lisbon trip",
    scope: "conversations",
  });

  expect(archiveHits.hits).toContainEqual(
    expect.objectContaining({ kind: "conversation", role: "user" })
  );

  // The memory_search Tool gives the model the same FTS5 hits.
  const second = await turn(h, router, `look up my travel plans${PADDING}`);

  const searchResult = second.requests.find(
    (request) => request.last?.role === "toolResult"
  );

  expect(searchResult?.lastText).toContain("travel.md");
  expect(second.reply).toContain("travel.md");

  // The snapshot stays frozen: later turns of the same Conversation do not see the new MEMORY.md line.
  for (const request of second.requests) {
    expect(request.system).toContain(INITIAL_MEMORY);
    expect(request.system).not.toContain(TURN_FACT);
  }

  // /compact runs the flush turn first, then the summary, then refreshes the snapshot.
  const binding = h.frontend.binding(AGENT, BINDING);
  const beforeCompact = replies(binding).length;
  const firstCompactRequest = router.requests.length;

  await h.frontend.command(AGENT, BINDING, CHAT, "compact");

  const compacted = await waitFor(
    () => replies(binding)[beforeCompact],
    "the /compact confirmation"
  );

  expect(deliveryText(compacted)).toBe("Compacted the Conversation.");

  const compactRequests = router.requests.slice(firstCompactRequest);

  const flushAt = compactRequests.findIndex((request) =>
    request.lastText.startsWith(FLUSH_MARKER)
  );

  const summaryAt = compactRequests.findIndex((request) =>
    request.lastText.includes(SUMMARY_MARKER)
  );

  expect(flushAt).toBeGreaterThanOrEqual(0);
  expect(summaryAt).toBeGreaterThan(flushAt);
  await expect(readFile(memoryFile(h, "MEMORY"), "utf-8")).resolves.toContain(
    FLUSH_FACT
  );

  // The flush turn is silent: only the confirmation reached the Chat.
  expect(replies(binding).slice(beforeCompact).map(deliveryText)).toEqual([
    "Compacted the Conversation.",
  ]);

  // The next turn sees the refreshed snapshot: the turn fact and the flush fact.
  const third = await turn(h, router, "what do you know now");

  expect(third.requests[0]?.system).toContain(TURN_FACT);
  expect(third.requests[0]?.system).toContain(FLUSH_FACT);
});

it("runs the Memory flush turn before an automatic compaction and saves its facts to Memory", async () => {
  const h = await startMemoryHarness(SMALL_CONTEXT_WINDOW);

  harness = h;

  const router = createRouter();
  const session = await h.connect();

  h.llm.faux.setResponses(router.responses);

  for (const word of ["first", "second", "third", "fourth"]) {
    // oxlint-disable-next-line no-await-in-loop -- Each message waits for the previous reply, like a person in a Chat.
    await turn(h, router, `${word} ${"x".repeat(LARGE_MESSAGE_CHARS)}`);
  }

  const flushAt = router.requests.findIndex((request) =>
    request.lastText.startsWith(FLUSH_MARKER)
  );

  const summaryAt = router.requests.findIndex((request) =>
    request.lastText.includes(SUMMARY_MARKER)
  );

  expect(flushAt).toBeGreaterThanOrEqual(0);
  expect(summaryAt).toBeGreaterThan(flushAt);

  // The flush turn's memory_write reached MEMORY.md and the FTS5 index.
  await waitFor(async () => {
    const memory = await readFile(memoryFile(h, "MEMORY"), "utf-8");

    return memory.includes(FLUSH_FACT) ? true : undefined;
  }, "the flushed fact in MEMORY.md");

  const hits = await session.request("memory.search", {
    agent: AGENT,
    query: "dentist",
    scope: "memory",
  });

  expect(hits.hits).toEqual([
    expect.objectContaining({ kind: "memory", name: "MEMORY" }),
  ]);

  // The flush turn stays out of the Chat: no delivery carries its Tool output.
  const binding = h.frontend.binding(AGENT, BINDING);

  for (const delivery of replies(binding)) {
    expect(deliveryText(delivery)).not.toContain("tool said");
  }
});
