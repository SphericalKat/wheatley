import type { Logger, RunEvent } from "@wheatley-ai/sdk";

import type { TelegramTarget } from "./chat-key.js";
import type { TelegramClient } from "./client.js";
import { SerialQueue } from "./serial-queue.js";

/** Telegram shows a typing indicator for about five seconds, so the Frontend repeats it before then. */
const TYPING_REPEAT_MS = 4000;

/** How long a finished Run keeps its draft for the final `message` delivery. */
const DRAFT_RETENTION_MS = 600_000;

/** The Bot API limit for the text of one message. */
const MAX_DRAFT_LENGTH = 4096;

const ELLIPSIS = "…";

/** The options of live Run output. */
export interface LiveOptions {
  readonly streaming: "draft" | "typing";
  readonly draftIntervalMs: number;
}

/** A draft message that a final reply replaces. */
export interface Draft {
  readonly target: TelegramTarget;
  readonly messageId: number;
}

interface RunState {
  readonly target: TelegramTarget;
  text: string;
  shown: string;
  messageId: number | undefined;
  lastFlushAt: number | undefined;
  typing: ReturnType<typeof setInterval> | undefined;
  flush: ReturnType<typeof setTimeout> | undefined;
  expiry: ReturnType<typeof setTimeout> | undefined;
  closed: boolean;
  /** Draft API calls of this Run, one at a time. */
  readonly calls: SerialQueue;
}

const draftText = (text: string): string =>
  text.length <= MAX_DRAFT_LENGTH
    ? text
    : `${text.slice(0, MAX_DRAFT_LENGTH - ELLIPSIS.length)}${ELLIPSIS}`;

const clearTimers = (state: RunState): void => {
  clearInterval(state.typing);
  clearTimeout(state.flush);
  clearTimeout(state.expiry);
  state.typing = undefined;
  state.flush = undefined;
  state.expiry = undefined;
};

/**
 * Shows live Run progress in Telegram: a repeated typing indicator between `run_started` and `run_finished`, and in
 * `draft` mode a plain-text draft message that receives at most one edit per `draftIntervalMs` (ADR 0012).
 *
 * Invariants: draft API calls of one Run run in order, one at a time. API failures are logged and never reach the
 * caller, because `FrontendBinding.onEvent` must not throw.
 */
export class LiveRuns {
  readonly #client: TelegramClient;
  readonly #log: Logger;
  readonly #options: LiveOptions;
  readonly #runs = new Map<string, RunState>();

  constructor(client: TelegramClient, log: Logger, options: LiveOptions) {
    this.#client = client;
    this.#log = log;
    this.#options = options;
  }

  /** Applies one Run event for a Chat at `target`. Never throws. */
  readonly onEvent = (event: RunEvent, target: TelegramTarget): void => {
    switch (event.kind) {
      case "run_started": {
        this.#stateOf(event.runId, target);
        break;
      }

      case "text_delta": {
        const state = this.#stateOf(event.runId, target);
        state.text += event.delta;

        if (this.#options.streaming === "draft") {
          this.#scheduleFlush(state);
        }

        break;
      }

      case "run_finished": {
        this.#finish(event.runId);
        break;
      }

      case "tool_started":
      case "tool_finished": {
        // Tool progress shows no extra output: the typing indicator already runs.
        break;
      }

      default: {
        break;
      }
    }
  };

  /**
   * Ends live output of a Run and returns its draft message, if one was sent. Waits for draft calls in flight, so the
   * caller can edit the draft without a race. Returns `undefined` for an unknown Run.
   */
  readonly takeDraft = async (runId: string): Promise<Draft | undefined> => {
    const state = this.#runs.get(runId);

    if (state === undefined) {
      return undefined;
    }

    state.closed = true;
    clearTimers(state);
    this.#runs.delete(runId);
    await state.calls.idle();

    return state.messageId === undefined
      ? undefined
      : { messageId: state.messageId, target: state.target };
  };

  /** Stops every timer. Later events still work, so `stop` is safe to call before the last event. */
  readonly stop = (): void => {
    for (const state of this.#runs.values()) {
      state.closed = true;
      clearTimers(state);
    }

    this.#runs.clear();
  };

  readonly #stateOf = (runId: string, target: TelegramTarget): RunState => {
    const existing = this.#runs.get(runId);

    if (existing !== undefined) {
      return existing;
    }

    const state: RunState = {
      calls: new SerialQueue(),
      closed: false,
      expiry: undefined,
      flush: undefined,
      lastFlushAt: undefined,
      messageId: undefined,
      shown: "",
      target,
      text: "",
      typing: undefined,
    };

    this.#runs.set(runId, state);
    void this.#sendTyping(state);
    state.typing = setInterval(() => {
      void this.#sendTyping(state);
    }, TYPING_REPEAT_MS);

    return state;
  };

  readonly #sendTyping = async (state: RunState): Promise<void> => {
    try {
      await this.#client.sendTyping(state.target);
    } catch (error) {
      this.#log.debug("Telegram typing indicator failed", {
        error: String(error),
      });
    }
  };

  readonly #finish = (runId: string): void => {
    const state = this.#runs.get(runId);

    if (state === undefined) {
      return;
    }

    clearInterval(state.typing);
    state.typing = undefined;

    if (state.expiry === undefined) {
      // A failed or stopped Run can end without a final `message` delivery that takes the draft.
      state.expiry = setTimeout(() => {
        if (this.#runs.get(runId) === state) {
          state.closed = true;
          clearTimers(state);
          this.#runs.delete(runId);
        }
      }, DRAFT_RETENTION_MS);
      state.expiry.unref();
    }
  };

  readonly #scheduleFlush = (state: RunState): void => {
    if (state.flush !== undefined || state.closed) {
      return;
    }

    const interval = this.#options.draftIntervalMs;

    const wait =
      state.lastFlushAt === undefined
        ? interval
        : Math.max(0, state.lastFlushAt + interval - Date.now());

    state.flush = setTimeout(() => {
      state.flush = undefined;
      // `#flush` never rejects.
      void state.calls.run(async () => {
        await this.#flush(state);
      });
    }, wait);
  };

  readonly #flush = async (state: RunState): Promise<void> => {
    if (state.closed) {
      return;
    }

    const text = draftText(state.text);
    state.lastFlushAt = Date.now();

    try {
      if (state.messageId === undefined) {
        state.messageId = await this.#client.sendMessage(state.target, text);
      } else if (text !== state.shown) {
        await this.#client.editMessageText(
          state.target.chatId,
          state.messageId,
          text
        );
      }

      state.shown = text;
    } catch (error) {
      this.#log.debug("Telegram draft update failed", { error: String(error) });
    }

    if (draftText(state.text) !== state.shown) {
      this.#scheduleFlush(state);
    }
  };
}
