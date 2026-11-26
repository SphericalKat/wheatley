import type { PendingApproval, RpcEvent } from "@wheatley-ai/protocol";

import { CLI_CHAT_ID } from "../core/agent/agent.js";
import { CLI_BINDING_ID } from "../core/config/validate.js";

/** True for a `run.started` or `run.finished` event of a Run in the CLI Chat. */
export const isCliChatRun = (event: RpcEvent): boolean =>
  (event.name === "run.started" || event.name === "run.finished") &&
  event.payload.run.origin.kind === "chat" &&
  event.payload.run.origin.bindingId === CLI_BINDING_ID &&
  event.payload.run.origin.chatId === CLI_CHAT_ID;

/**
 * Tracks the Runs of the CLI Chat and its open Approvals while the chat runs. A sent message counts as busy until the
 * Agent's echo of it names its Run. The echo and the Run events can arrive before or after the `chat.send` response
 * is handled, so every step works in any order.
 */
export class ChatState {
  readonly approvals: PendingApproval[] = [];
  readonly #waiting = new Set<string>();
  readonly #echoed = new Set<string>();
  readonly #active = new Set<string>();
  readonly #finished = new Set<string>();
  #idle = Promise.withResolvers<undefined>();

  constructor() {
    this.#idle.resolve(undefined);
  }

  readonly removeApproval = (approvalId: string): void => {
    const index = this.approvals.findIndex(
      (approval) => approval.approvalId === approvalId
    );

    if (index !== -1) {
      this.approvals.splice(index, 1);
    }
  };

  /** This chat sent a message. */
  readonly sent = (messageId: string): void => {
    if (this.#echoed.delete(messageId)) {
      return;
    }

    this.#busy();
    this.#waiting.add(messageId);
  };

  /** The Agent stored a user message of this Chat for a Run. */
  readonly echoed = (messageId: string, runId: string | undefined): void => {
    if (!this.#waiting.delete(messageId)) {
      this.#echoed.add(messageId);
    }

    if (runId !== undefined) {
      this.started(runId);
    }

    this.#settle();
  };

  readonly started = (runId: string): void => {
    if (this.#finished.has(runId)) {
      return;
    }

    this.#busy();
    this.#active.add(runId);
  };

  readonly finished = (runId: string): void => {
    this.#finished.add(runId);
    this.#active.delete(runId);
    this.#settle();
  };

  /** True while a message waits for its Run or a Run of the CLI Chat is active. */
  get busy(): boolean {
    return this.#active.size > 0 || this.#waiting.size > 0;
  }

  /** Resolves when no message waits for its Run and no Run of the CLI Chat is active. */
  get idle(): Promise<undefined> {
    return this.#idle.promise;
  }

  readonly #busy = (): void => {
    if (this.#active.size === 0 && this.#waiting.size === 0) {
      this.#idle = Promise.withResolvers<undefined>();
    }
  };

  readonly #settle = (): void => {
    if (this.#active.size === 0 && this.#waiting.size === 0) {
      this.#idle.resolve(undefined);
    }
  };
}

/** Updates the chat state for one event. */
export const track = (state: ChatState, event: RpcEvent): void => {
  if (event.name === "chat.message" && event.payload.message.role === "user") {
    state.echoed(event.payload.message.messageId, event.payload.message.runId);
  } else if (event.name === "approval.requested") {
    state.approvals.push(event.payload.approval);
  } else if (event.name === "approval.resolved") {
    state.removeApproval(event.payload.approvalId);
  } else if (isCliChatRun(event) && event.name === "run.started") {
    state.started(event.payload.run.runId);
  } else if (isCliChatRun(event) && event.name === "run.finished") {
    state.finished(event.payload.run.runId);
  }
};
