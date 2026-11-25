import type {
  ApprovalRequestedDelivery,
  ApprovalResolvedDelivery,
  Delivery,
  MessageDelivery,
} from "@wheatley-ai/sdk";
import { chunkMarkdown } from "@wheatley-ai/sdk";

import {
  approvalOutcomeText,
  approvalRequestBlocks,
  approvalRequestText,
  approvalResolvedBlocks,
  approvalResolvedText,
} from "./approval-blocks.js";
import { assertAttachmentSizes, uploadAttachment } from "./attachments.js";
import { dropOldest } from "./bounded.js";
import { parseChatId } from "./chat-id.js";
import type { SlackChatTarget } from "./chat-id.js";
import type { LiveProgress } from "./live-progress.js";
import { MAX_MARKDOWN_LENGTH } from "./live-progress.js";
import { postToChat } from "./slack-client.js";
import type { SlackWebClient } from "./slack-client.js";
import type { SlackStateStore } from "./state-store.js";

/** The number of delivered outbox IDs that the binding remembers to drop duplicate deliveries. */
const MAX_DELIVERED_MESSAGES = 1000;

/** Progress of one `message` delivery, so a retry resumes after the last part that Slack confirmed. */
interface MessageProgress {
  done: number;
  /** The draft reply that the first chunk replaces. */
  readonly draftTs: string | undefined;
}

/** What the outbound side of a started binding uses. */
export interface OutboundDeps {
  readonly web: SlackWebClient;
  readonly store: SlackStateStore;
  readonly live: LiveProgress;
  readonly maxAttachmentBytes: number;
}

const postChunk = async (
  web: SlackWebClient,
  target: SlackChatTarget,
  chunk: string,
  replaceTs: string | undefined
): Promise<void> => {
  if (replaceTs === undefined) {
    await postToChat(web, target, { markdown_text: chunk });

    return;
  }

  await web.chat.update({
    channel: target.channel,
    markdown_text: chunk,
    ts: replaceTs,
  });
};

/** Posts the Block Kit prompt once per `approvalId`, and stores its message for the update on resolve. */
const deliverApprovalRequested = async (
  deps: OutboundDeps,
  delivery: ApprovalRequestedDelivery
): Promise<void> => {
  if (deps.store.approval(delivery.approvalId) !== undefined) {
    return;
  }

  const target = parseChatId(delivery.chatId);

  const ts = await postToChat(deps.web, target, {
    blocks: approvalRequestBlocks(delivery),
    text: approvalRequestText(delivery),
  });

  if (ts === undefined) {
    throw new Error("Slack chat.postMessage returned no message ts");
  }

  await deps.store.putApproval(delivery.approvalId, {
    channel: target.channel,
    chatId: delivery.chatId,
    inputPreview: delivery.inputPreview,
    resolved: false,
    toolName: delivery.toolName,
    ts,
  });
};

/**
 * Replaces the prompt with the outcome and removes its buttons. If the binding has no record of the prompt, it posts
 * the outcome as a new message. A repeated delivery after success does nothing.
 */
const deliverApprovalResolved = async (
  deps: OutboundDeps,
  delivery: ApprovalResolvedDelivery
): Promise<void> => {
  const record = deps.store.approval(delivery.approvalId);

  if (record?.resolved === true) {
    return;
  }

  if (record !== undefined) {
    await deps.web.chat.update({
      blocks: approvalResolvedBlocks(record, delivery),
      channel: record.channel,
      text: approvalResolvedText(record, delivery),
      ts: record.ts,
    });
    await deps.store.putApproval(delivery.approvalId, {
      ...record,
      resolved: true,
    });

    return;
  }

  const target = parseChatId(delivery.chatId);

  const ts = await postToChat(deps.web, target, {
    text: approvalOutcomeText(delivery),
  });

  if (ts !== undefined) {
    await deps.store.putApproval(delivery.approvalId, {
      channel: target.channel,
      chatId: delivery.chatId,
      inputPreview: "",
      resolved: true,
      toolName: "",
      ts,
    });
  }
};

/** Delivers durable outbound work to Slack. Keeps the per-message progress that makes retries safe. */
export class SlackOutbound {
  readonly #deps: OutboundDeps;
  readonly #delivered = new Set<string>();
  readonly #progress = new Map<string, MessageProgress>();

  constructor(deps: OutboundDeps) {
    this.#deps = deps;
  }

  /**
   * Delivers one item. Rejects with the raw Slack error, which the binding converts with `toDeliveryError`. After
   * a thread delivery, replies in that thread need no bot mention.
   */
  readonly deliver = async (delivery: Delivery): Promise<void> => {
    switch (delivery.kind) {
      case "message": {
        await this.#deliverMessage(delivery);
        break;
      }

      case "approval_requested": {
        await deliverApprovalRequested(this.#deps, delivery);
        break;
      }

      case "approval_resolved": {
        await deliverApprovalResolved(this.#deps, delivery);
        break;
      }

      default: {
        break;
      }
    }

    if (parseChatId(delivery.chatId).threadTs !== undefined) {
      await this.#deps.store.engage(delivery.chatId);
    }
  };

  /**
   * Posts the Markdown chunks, then uploads the attachments. If the message finishes a streamed Run, the first chunk
   * replaces the draft reply. A retry resumes after the last part that Slack confirmed, and a repeated `messageId`
   * after success does nothing.
   */
  readonly #deliverMessage = async (
    delivery: MessageDelivery
  ): Promise<void> => {
    if (this.#delivered.has(delivery.messageId)) {
      return;
    }

    const { web } = this.#deps;
    const attachments = delivery.attachments ?? [];
    assertAttachmentSizes(attachments, this.#deps.maxAttachmentBytes);

    const target = parseChatId(delivery.chatId);

    const chunks =
      delivery.text.trim() === ""
        ? []
        : chunkMarkdown(delivery.text, MAX_MARKDOWN_LENGTH);

    const progress = await this.#messageProgress(delivery);

    const steps = [
      ...chunks.map((chunk, index) => async () => {
        await postChunk(
          web,
          target,
          chunk,
          index === 0 ? progress.draftTs : undefined
        );
      }),
      ...attachments.map((attachment) => async () => {
        await uploadAttachment(web, target, attachment);
      }),
    ];

    for (const step of steps.slice(progress.done)) {
      // oxlint-disable-next-line no-await-in-loop -- Slack must show chunks and files in order.
      await step();
      progress.done += 1;
    }

    this.#progress.delete(delivery.messageId);
    this.#delivered.add(delivery.messageId);
    dropOldest(this.#delivered, MAX_DELIVERED_MESSAGES);
  };

  readonly #messageProgress = async (
    delivery: MessageDelivery
  ): Promise<MessageProgress> => {
    const existing = this.#progress.get(delivery.messageId);

    if (existing !== undefined) {
      return existing;
    }

    const draft =
      delivery.runId === undefined
        ? undefined
        : await this.#deps.live.takeDraft(delivery.runId);

    const progress: MessageProgress = { done: 0, draftTs: draft?.ts };

    this.#progress.set(delivery.messageId, progress);

    return progress;
  };
}
