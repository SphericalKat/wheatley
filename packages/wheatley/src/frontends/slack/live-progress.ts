import type { Logger, RunEvent } from "@wheatley/sdk";

import { parseChatId } from "./chat-id.js";
import type { SlackChatTarget } from "./chat-id.js";
import type { StreamingMode } from "./config.js";
import { postToChat } from "./slack-client.js";
import type { SlackWebClient } from "./slack-client.js";

/** Slack accepts at most 12,000 characters of `markdown_text` per message. */
export const MAX_MARKDOWN_LENGTH = 12_000;

/** How long the binding keeps a finished draft for the final `message` delivery with the same `runId`. */
const DRAFT_RETENTION_MS = 600_000;

const ELLIPSIS = "…";

/** A Slack message that the binding received or posted. */
export interface PostedMessage {
  readonly channel: string;
  readonly ts: string;
}

/** A streamed draft reply that the final `message` delivery replaces. */
export interface FinishedDraft {
  readonly target: SlackChatTarget;
  /** Absent if the draft never reached Slack, for example because no text arrived. */
  readonly ts: string | undefined;
}

interface Draft {
  readonly target: SlackChatTarget;
  text: string;
  sentText: string;
  ts: string | undefined;
  lastSentAt: number;
  timer: NodeJS.Timeout | undefined;
  retention: NodeJS.Timeout | undefined;
  writes: Promise<void>;
}

/** What the live progress view needs from the binding. */
export interface LiveProgressDeps {
  readonly client: SlackWebClient;
  readonly log: Logger;
  readonly streaming: StreamingMode;
  readonly editIntervalMs: number;
  readonly typingReaction: string;
  /** The latest user message of a Chat that the binding forwarded, for the typing reaction. */
  readonly lastInbound: (chatId: string) => PostedMessage | undefined;
}

const truncate = (text: string): string =>
  text.length <= MAX_MARKDOWN_LENGTH
    ? text
    : `${text.slice(0, MAX_MARKDOWN_LENGTH - ELLIPSIS.length)}${ELLIPSIS}`;

/**
 * Shows live Run progress in Slack (ADR 0012): a reaction on the user message as the typing indicator, and, in `edit`
 * streaming mode, a draft reply that the binding edits at most once per `editIntervalMs`.
 *
 * Every Slack call is best effort. Failures log at `debug` level and never reach the caller.
 */
export class LiveProgress {
  readonly #deps: LiveProgressDeps;
  readonly #drafts = new Map<string, Draft>();
  readonly #typing = new Map<string, PostedMessage>();
  readonly #reactionCalls = new Set<Promise<void>>();

  constructor(deps: LiveProgressDeps) {
    this.#deps = deps;
  }

  /** Handles one Run event. Never throws and never waits for Slack. */
  readonly onEvent = (event: RunEvent): void => {
    switch (event.kind) {
      case "run_started": {
        this.#startTyping(event.runId, event.chatId);
        break;
      }

      case "text_delta": {
        this.#appendDraft(event.runId, event.chatId, event.delta);
        break;
      }

      case "run_finished": {
        this.#stopTyping(event.runId);
        this.#finishDraft(event.runId);
        break;
      }

      case "tool_started":
      case "tool_finished": {
        break;
      }

      default: {
        break;
      }
    }
  };

  /**
   * Removes the draft of a Run and returns it, after every pending draft write finished. Returns `undefined` if the Run
   * has no draft. The caller then replaces the draft with the final message.
   */
  readonly takeDraft = async (
    runId: string
  ): Promise<FinishedDraft | undefined> => {
    const draft = this.#drafts.get(runId);

    if (draft === undefined) {
      return undefined;
    }

    this.#drafts.delete(runId);
    clearTimeout(draft.timer);
    clearTimeout(draft.retention);
    await draft.writes;

    return { target: draft.target, ts: draft.ts };
  };

  /** Cancels timers and removes typing reactions. Resolves after pending Slack calls finished. */
  readonly stop = async (): Promise<void> => {
    const drafts = [...this.#drafts.values()];
    this.#drafts.clear();

    for (const draft of drafts) {
      clearTimeout(draft.timer);
      clearTimeout(draft.retention);
    }

    for (const runId of this.#typing.keys()) {
      this.#stopTyping(runId);
    }

    await Promise.all([
      ...drafts.map(async (draft) => {
        await draft.writes;
      }),
      ...this.#reactionCalls,
    ]);
  };

  readonly #startTyping = (runId: string, chatId: string): void => {
    const message = this.#deps.lastInbound(chatId);

    if (message !== undefined) {
      this.#typing.set(runId, message);
      this.#trackReaction(this.#react("add", message));
    }
  };

  readonly #stopTyping = (runId: string): void => {
    const message = this.#typing.get(runId);

    if (message !== undefined) {
      this.#typing.delete(runId);
      this.#trackReaction(this.#react("remove", message));
    }
  };

  readonly #trackReaction = (call: Promise<void>): void => {
    this.#reactionCalls.add(call);
    void this.#forgetReaction(call);
  };

  readonly #forgetReaction = async (call: Promise<void>): Promise<void> => {
    await call;
    this.#reactionCalls.delete(call);
  };

  readonly #react = async (
    action: "add" | "remove",
    message: PostedMessage
  ): Promise<void> => {
    const args = {
      channel: message.channel,
      name: this.#deps.typingReaction,
      timestamp: message.ts,
    };

    try {
      await (action === "add"
        ? this.#deps.client.reactions.add(args)
        : this.#deps.client.reactions.remove(args));
    } catch (error) {
      this.#deps.log.debug(`Could not ${action} the typing reaction`, {
        error: String(error),
      });
    }
  };

  readonly #appendDraft = (
    runId: string,
    chatId: string,
    delta: string
  ): void => {
    if (this.#deps.streaming !== "edit") {
      return;
    }

    const draft = this.#drafts.get(runId) ?? {
      lastSentAt: 0,
      retention: undefined,
      sentText: "",
      target: parseChatId(chatId),
      text: "",
      timer: undefined,
      ts: undefined,
      writes: Promise.resolve(),
    };

    this.#drafts.set(runId, draft);
    draft.text += delta;
    this.#schedule(draft);
  };

  /** Flushes at once if the last edit is `editIntervalMs` old, else when it is. Later deltas join that flush. */
  readonly #schedule = (draft: Draft): void => {
    if (draft.timer !== undefined) {
      return;
    }

    const delay = Math.max(
      0,
      draft.lastSentAt + this.#deps.editIntervalMs - Date.now()
    );

    draft.timer = setTimeout(() => {
      draft.timer = undefined;
      this.#flush(draft);
    }, delay);
  };

  readonly #flush = (draft: Draft): void => {
    const { text } = draft;

    if (text === draft.sentText || text.trim() === "") {
      return;
    }

    draft.sentText = text;
    draft.lastSentAt = Date.now();
    draft.writes = this.#writeAfter(draft.writes, draft, truncate(text));
  };

  /** Posts the draft, or edits it once it exists. Writes of one draft run one at a time. Never rejects. */
  readonly #writeAfter = async (
    previous: Promise<void>,
    draft: Draft,
    text: string
  ): Promise<void> => {
    await previous;

    try {
      if (draft.ts === undefined) {
        draft.ts = await postToChat(this.#deps.client, draft.target, {
          markdown_text: text,
        });
      } else {
        await this.#deps.client.chat.update({
          channel: draft.target.channel,
          markdown_text: text,
          ts: draft.ts,
        });
      }
    } catch (error) {
      this.#deps.log.debug("Could not update the draft reply", {
        error: String(error),
      });
    }
  };

  /** Keeps the draft for the final `message` delivery. A pending flush still sends the last text. */
  readonly #finishDraft = (runId: string): void => {
    const draft = this.#drafts.get(runId);

    if (draft === undefined) {
      return;
    }

    draft.retention = setTimeout(() => {
      if (this.#drafts.get(runId) === draft) {
        this.#drafts.delete(runId);
      }
    }, DRAFT_RETENTION_MS);
    draft.retention.unref();
  };
}
