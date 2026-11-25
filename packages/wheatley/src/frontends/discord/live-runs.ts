import type { Logger, RunEvent } from "@wheatley/sdk";

import type { StreamingMode } from "./config.js";
import { NO_MENTIONS } from "./discord-runtime.js";
import type { SendableChannel, SentMessage } from "./discord-runtime.js";
import { errorText } from "./errors.js";
import { RecentIds } from "./recent-ids.js";

/** Discord limits message content to this many characters. */
export const DISCORD_MESSAGE_MAX_LENGTH = 2000;

/** Discord shows a typing indicator for 10 seconds, so the binding renews it before that. */
const TYPING_RENEW_MS = 8000;

/** Stops typing and forgets a draft if no `run_finished` event or final delivery arrives in this time. */
const ABANDONED_RUN_MS = 10 * 60_000;

const ELLIPSIS = "…";

/** How many finalized Runs the binding remembers, so that a late event cannot start a second draft. */
const FINALIZED_RUN_LIMIT = 1000;

/** What `LiveRuns` needs from the binding. */
export interface LiveRunsOptions {
  readonly mode: StreamingMode;
  readonly editIntervalMs: number;
  /** Fetches the channel of an allowed Chat. Rejects for a Chat that is not allowed or not text-based. */
  readonly resolveChannel: (chatId: string) => Promise<SendableChannel>;
  readonly log: Logger;
}

interface RunState {
  readonly runId: string;
  readonly chatId: string;
  channel: SendableChannel | undefined;
  text: string;
  shownText: string;
  draft: SentMessage | undefined;
  lastEditAt: number;
  editTimer: NodeJS.Timeout | undefined;
  typingTimer: NodeJS.Timeout | undefined;
  expiryTimer: NodeJS.Timeout | undefined;
  closed: boolean;
  chain: Promise<void>;
}

const draftText = (text: string): string =>
  text.length > DISCORD_MESSAGE_MAX_LENGTH
    ? `${text.slice(0, DISCORD_MESSAGE_MAX_LENGTH - 1)}${ELLIPSIS}`
    : text;

const stopTyping = (state: RunState): void => {
  clearInterval(state.typingTimer);
  state.typingTimer = undefined;
};

/**
 * Shows live Run progress in Discord: a typing indicator from `run_started` to `run_finished`, and in `edit` mode a
 * draft message that shows the `text_delta` text so far, edited at most once per `editIntervalMs`.
 *
 * Every Discord call of one Run runs in order on one promise chain, so an edit can never overwrite the final text
 * that `finalize` hands to the delivery.
 */
export class LiveRuns {
  readonly #options: LiveRunsOptions;
  readonly #runs = new Map<string, RunState>();
  readonly #finalized = new RecentIds(FINALIZED_RUN_LIMIT);

  constructor(options: LiveRunsOptions) {
    this.#options = options;
  }

  /**
   * Handles one Run event. Never throws: it logs failed Discord calls at `warn` level. Ignores events of a Run that
   * `finalize` ended.
   */
  readonly onEvent = (event: RunEvent): void => {
    if (this.#finalized.has(event.runId)) {
      return;
    }

    // The live view shows no tool progress, so it ignores `tool_started` and `tool_finished`.
    if (event.kind === "run_started") {
      this.#startTyping(this.#state(event.runId, event.chatId));
    } else if (event.kind === "text_delta") {
      this.#append(this.#state(event.runId, event.chatId), event.delta);
    } else if (event.kind === "run_finished") {
      this.#finish(event.runId);
    }
  };

  /**
   * Ends the live view of `runId` and returns its draft message, if the binding sent one, after every pending Discord
   * call of the Run settles. The binding ignores later events of the Run. Never rejects.
   */
  readonly finalize = async (
    runId: string
  ): Promise<SentMessage | undefined> => {
    this.#finalized.add(runId);
    const state = this.#runs.get(runId);

    if (state === undefined) {
      return undefined;
    }

    this.#close(state);
    await state.chain;

    return state.draft;
  };

  /** Stops every timer. The binding calls it when it stops. */
  readonly dispose = (): void => {
    for (const state of this.#runs.values()) {
      this.#close(state);
    }
  };

  #state(runId: string, chatId: string): RunState {
    const existing = this.#runs.get(runId);

    if (existing !== undefined) {
      return existing;
    }

    const state: RunState = {
      chain: Promise.resolve(),
      channel: undefined,
      chatId,
      closed: false,
      draft: undefined,
      editTimer: undefined,
      expiryTimer: undefined,
      lastEditAt: 0,
      runId,
      shownText: "",
      text: "",
      typingTimer: undefined,
    };

    state.expiryTimer = setTimeout(() => {
      this.#close(state);
    }, ABANDONED_RUN_MS);
    state.expiryTimer.unref();
    this.#runs.set(runId, state);

    return state;
  }

  #enqueue(state: RunState, action: string, step: () => Promise<void>): void {
    const run = async (): Promise<void> => {
      if (state.closed) {
        return;
      }

      try {
        await step();
      } catch (error) {
        this.#options.log.warn(`Discord could not ${action}`, {
          chatId: state.chatId,
          error: errorText(error),
          runId: state.runId,
        });
      }
    };

    state.chain = state.chain.then(run);
  }

  async #channel(state: RunState): Promise<SendableChannel> {
    state.channel ??= await this.#options.resolveChannel(state.chatId);

    return state.channel;
  }

  #startTyping(state: RunState): void {
    if (state.typingTimer !== undefined || state.closed) {
      return;
    }

    const sendTyping = (): void => {
      this.#enqueue(state, "show the typing indicator", async () => {
        const channel = await this.#channel(state);
        await channel.sendTyping();
      });
    };

    sendTyping();
    state.typingTimer = setInterval(sendTyping, TYPING_RENEW_MS);
    state.typingTimer.unref();
  }

  #append(state: RunState, delta: string): void {
    if (state.closed) {
      return;
    }

    this.#startTyping(state);

    if (this.#options.mode === "typing") {
      return;
    }

    state.text += delta;

    if (state.editTimer !== undefined) {
      return;
    }

    const wait = Math.max(
      0,
      state.lastEditAt + this.#options.editIntervalMs - Date.now()
    );

    state.editTimer = setTimeout(() => {
      state.editTimer = undefined;
      this.#enqueue(state, "update the draft message", async () => {
        await this.#flush(state);
      });
    }, wait);
  }

  async #flush(state: RunState): Promise<void> {
    const content = draftText(state.text);

    if (content.trim() === "" || content === state.shownText) {
      return;
    }

    if (state.draft === undefined) {
      const channel = await this.#channel(state);
      state.draft = await channel.send({
        allowedMentions: NO_MENTIONS,
        content,
      });
    } else {
      await state.draft.edit({ allowedMentions: NO_MENTIONS, content });
    }

    state.shownText = content;
    state.lastEditAt = Date.now();
  }

  #finish(runId: string): void {
    const state = this.#runs.get(runId);

    if (state !== undefined) {
      stopTyping(state);
    }
  }

  #close(state: RunState): void {
    state.closed = true;
    stopTyping(state);
    clearTimeout(state.editTimer);
    clearTimeout(state.expiryTimer);
    state.editTimer = undefined;

    if (this.#runs.get(state.runId) === state) {
      this.#runs.delete(state.runId);
    }
  }
}
