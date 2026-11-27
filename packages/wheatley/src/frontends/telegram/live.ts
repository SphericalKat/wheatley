import { decode, isJsonValue } from "@wheatley-ai/protocol";
import type { Logger, RunEvent } from "@wheatley-ai/sdk";
import { Type } from "typebox";

import type { TelegramTarget } from "./chat-key.js";
import type { TelegramClient } from "./client.js";
import { SerialQueue } from "./serial-queue.js";

/** Telegram shows a typing indicator for about five seconds, so the Frontend repeats it before then. */
const TYPING_REPEAT_MS = 4000;

/** How long a finished Run keeps its draft for the final `message` delivery. */
const DRAFT_RETENTION_MS = 600_000;

/** Older drafts stay as-is so the final reply arrives as a fresh message at the bottom of the chat. */
const MAX_DRAFT_EDIT_AGE_MS = 30_000;

/** The Bot API limit for the text of one message. */
const MAX_DRAFT_LENGTH = 4096;

/** Maximum length of one tool argument preview in the progress bubble. */
const MAX_TOOL_PREVIEW_LENGTH = 60;

const ELLIPSIS = "…";
const WHITESPACE = /\s+/gu;

const ToolPreviewObjectSchema = Type.Object({
  command: Type.Optional(Type.String()),
  path: Type.Optional(Type.String()),
  query: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
});

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

interface ToolProgressItem {
  readonly callId: string;
  readonly name: string;
  readonly preview: string | undefined;
  status: "running" | "done" | "error";
}

interface RunState {
  readonly target: TelegramTarget;
  text: string;
  shown: string;
  messageId: number | undefined;
  draftCreatedAt: number | undefined;
  lastFlushAt: number | undefined;
  toolMessageId: number | undefined;
  toolShown: string;
  tools: ToolProgressItem[];
  typing: ReturnType<typeof setInterval> | undefined;
  flush: ReturnType<typeof setTimeout> | undefined;
  expiry: ReturnType<typeof setTimeout> | undefined;
  closed: boolean;
  /** Draft and tool-progress API calls of this Run, one at a time. */
  readonly calls: SerialQueue;
}

const draftText = (text: string): string =>
  text.length <= MAX_DRAFT_LENGTH
    ? text
    : `${text.slice(0, MAX_DRAFT_LENGTH - ELLIPSIS.length)}${ELLIPSIS}`;

const truncateInline = (text: string, maxLength: number): string => {
  const singleLine = text.replaceAll(WHITESPACE, " ").trim();

  if (singleLine.length <= maxLength) {
    return singleLine;
  }

  return `${singleLine.slice(0, maxLength - ELLIPSIS.length)}${ELLIPSIS}`;
};

const extractToolPreview = (raw: string | undefined): string | undefined => {
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(raw);

    if (isJsonValue(parsed)) {
      const decoded = decode(ToolPreviewObjectSchema, parsed);

      if (decoded.ok) {
        const { command, path, query, url } = decoded.value;
        const primary = command ?? path ?? query ?? url;

        if (primary !== undefined && primary.trim() !== "") {
          return truncateInline(primary, MAX_TOOL_PREVIEW_LENGTH);
        }
      }
    }
  } catch {
    // Non-JSON preview falls back to raw text.
  }

  return truncateInline(raw, MAX_TOOL_PREVIEW_LENGTH);
};

const toolIcon = (status: ToolProgressItem["status"]): string => {
  if (status === "running") {
    return "⏳";
  }

  return status === "error" ? "✗" : "✓";
};

const formatToolProgress = (tools: readonly ToolProgressItem[]): string =>
  draftText(
    tools
      .map((item) =>
        item.preview === undefined
          ? `${toolIcon(item.status)} ${item.name}`
          : `${toolIcon(item.status)} ${item.name}: ${item.preview}`
      )
      .join("\n")
  );

const clearTimers = (state: RunState): void => {
  clearInterval(state.typing);
  clearTimeout(state.flush);
  clearTimeout(state.expiry);
  state.typing = undefined;
  state.flush = undefined;
  state.expiry = undefined;
};

const detachTextDraft = (state: RunState): void => {
  clearTimeout(state.flush);
  state.flush = undefined;
  state.text = "";
  state.shown = "";
  state.messageId = undefined;
  state.draftCreatedAt = undefined;
  state.lastFlushAt = undefined;
};

/**
 * Shows live Run progress in Telegram: a repeated typing indicator between `run_started` and `run_finished`, and in
 * `draft` mode a plain-text draft message plus an accumulated tool-progress bubble (ADR 0012).
 *
 * When a tool starts after streamed text, the pre-tool text draft is detached so the post-tool reply arrives as a
 * fresh message below the tool progress instead of editing an older message higher up in the chat.
 *
 * Invariants: API calls of one Run run in order, one at a time. API failures are logged and never reach the caller,
 * because `FrontendBinding.onEvent` must not throw.
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
        this.#onTextDelta(event.runId, target, event.delta);
        break;
      }

      case "tool_started": {
        this.#onToolStarted(
          event.runId,
          target,
          event.toolCallId,
          event.toolName,
          event.inputPreview
        );
        break;
      }

      case "tool_finished": {
        this.#onToolFinished(
          event.runId,
          target,
          event.toolCallId,
          event.isError
        );
        break;
      }

      case "run_finished": {
        this.#finish(event.runId);
        break;
      }

      default: {
        break;
      }
    }
  };

  /**
   * Ends live output of a Run and returns its current draft message, if one was sent recently enough to edit in place.
   * Waits for draft calls in flight, so the caller can edit the draft without a race. Returns `undefined` when no
   * editable draft exists (for example after a tool segment break or when the draft is stale).
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

    if (state.messageId === undefined) {
      return undefined;
    }

    if (
      state.draftCreatedAt !== undefined &&
      Date.now() - state.draftCreatedAt > MAX_DRAFT_EDIT_AGE_MS
    ) {
      return undefined;
    }

    return { messageId: state.messageId, target: state.target };
  };

  /** Stops every timer. Later events still work, so `stop` is safe to call before the last event. */
  readonly stop = (): void => {
    for (const state of this.#runs.values()) {
      state.closed = true;
      clearTimers(state);
    }

    this.#runs.clear();
  };

  readonly #onTextDelta = (
    runId: string,
    target: TelegramTarget,
    delta: string
  ): void => {
    const state = this.#stateOf(runId, target);

    if (this.#options.streaming !== "draft") {
      return;
    }

    // Seal the completed tool-progress bubble so the post-tool reply starts in a fresh message below it.
    if (state.tools.length > 0) {
      state.toolMessageId = undefined;
      state.toolShown = "";
      state.tools = [];
    }

    state.text += delta;
    this.#scheduleFlush(state);
  };

  readonly #onToolStarted = (
    runId: string,
    target: TelegramTarget,
    callId: string,
    name: string,
    inputPreview: string | undefined
  ): void => {
    const state = this.#stateOf(runId, target);

    if (this.#options.streaming !== "draft") {
      return;
    }

    detachTextDraft(state);
    state.tools.push({
      callId,
      name,
      preview: extractToolPreview(inputPreview),
      status: "running",
    });

    const rendered = formatToolProgress(state.tools);

    void state.calls.run(async () => {
      await this.#flushTools(state, rendered);
    });
  };

  readonly #onToolFinished = (
    runId: string,
    target: TelegramTarget,
    callId: string,
    isError: boolean
  ): void => {
    const state = this.#stateOf(runId, target);

    if (this.#options.streaming !== "draft") {
      return;
    }

    const entry = state.tools.find((item) => item.callId === callId);

    if (entry === undefined) {
      return;
    }

    entry.status = isError ? "error" : "done";

    const rendered = formatToolProgress(state.tools);

    void state.calls.run(async () => {
      await this.#flushTools(state, rendered);
    });
  };

  readonly #stateOf = (runId: string, target: TelegramTarget): RunState => {
    const existing = this.#runs.get(runId);

    if (existing !== undefined) {
      return existing;
    }

    const state: RunState = {
      calls: new SerialQueue(),
      closed: false,
      draftCreatedAt: undefined,
      expiry: undefined,
      flush: undefined,
      lastFlushAt: undefined,
      messageId: undefined,
      shown: "",
      target,
      text: "",
      toolMessageId: undefined,
      tools: [],
      toolShown: "",
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
    if (state.closed || state.text === "") {
      return;
    }

    const text = draftText(state.text);
    state.lastFlushAt = Date.now();

    try {
      if (state.messageId === undefined) {
        state.messageId = await this.#client.sendMessage(state.target, text);
        state.draftCreatedAt = Date.now();
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

    if (state.text !== "" && draftText(state.text) !== state.shown) {
      this.#scheduleFlush(state);
    }
  };

  readonly #flushTools = async (
    state: RunState,
    text: string
  ): Promise<void> => {
    if (state.closed || text === state.toolShown) {
      return;
    }

    try {
      if (state.toolMessageId === undefined) {
        state.toolMessageId = await this.#client.sendMessage(
          state.target,
          text
        );
      } else {
        await this.#client.editMessageText(
          state.target.chatId,
          state.toolMessageId,
          text
        );
      }

      state.toolShown = text;
    } catch (error) {
      this.#log.debug("Telegram tool progress update failed", {
        error: String(error),
      });
    }
  };
}
