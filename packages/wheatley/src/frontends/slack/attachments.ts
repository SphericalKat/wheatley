import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Attachment } from "@wheatley-ai/sdk";
import { DeliveryError } from "@wheatley-ai/sdk";

import type { SlackChatTarget } from "./chat-id.js";
import type { SlackFile } from "./inbound.js";
import type { SlackWebClient } from "./slack-client.js";

/**
 * Downloads one Slack file with the given headers.
 *
 * Resolves with the response for any HTTP status. `stageInboundFile` treats a non-2xx status as a failed download.
 * A rejection means a network failure, which `stageInboundFile` also reports as `download_failed`.
 */
export type FetchFunction = (
  url: string,
  init: { readonly headers: Readonly<Record<string, string>> }
) => Promise<Response>;

const UNSAFE_FILENAME_CHARACTERS = /[^A-Za-z0-9._-]+/gu;
const MAX_STAGED_NAME_LENGTH = 100;

/** Why the binding skipped an inbound file. */
export type SkippedFile = "too_large" | "no_url" | "download_failed";

/** The result of one inbound file download. */
export type DownloadResult =
  | { readonly ok: true; readonly attachment: Attachment }
  | { readonly ok: false; readonly reason: SkippedFile };

/** Where and how the binding stages inbound files. */
export interface StagingOptions {
  readonly botToken: string;
  readonly stagingDir: string;
  readonly maxBytes: number;
  readonly fetch: FetchFunction;
}

const stagedName = (name: string): string =>
  `${randomUUID()}-${name.replaceAll(UNSAFE_FILENAME_CHARACTERS, "_").slice(-MAX_STAGED_NAME_LENGTH)}`;

class FileTooLargeError extends Error {
  override readonly name = "FileTooLargeError";
}

const readLimited = async (
  response: Response,
  maxBytes: number
): Promise<Uint8Array> => {
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);

  if (declared > maxBytes) {
    throw new FileTooLargeError(`Content-Length ${declared} exceeds the limit`);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;

  if (response.body === null) {
    return new Uint8Array();
  }

  for await (const chunk of response.body) {
    total += chunk.byteLength;

    if (total > maxBytes) {
      throw new FileTooLargeError(`The download exceeds ${maxBytes} bytes`);
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
};

/**
 * Downloads one file of an inbound Slack message into `stagingDir`.
 *
 * Skips a file that Slack reports as larger than `maxBytes`, and stops a download that grows past `maxBytes`.
 * Never rejects.
 */
export const stageInboundFile = async (
  file: SlackFile,
  options: StagingOptions
): Promise<DownloadResult> => {
  if (file.sizeBytes !== undefined && file.sizeBytes > options.maxBytes) {
    return { ok: false, reason: "too_large" };
  }

  if (file.url === undefined) {
    return { ok: false, reason: "no_url" };
  }

  try {
    const response = await options.fetch(file.url, {
      headers: { authorization: `Bearer ${options.botToken}` },
    });

    if (!response.ok) {
      return { ok: false, reason: "download_failed" };
    }

    const data = await readLimited(response, options.maxBytes);
    const stagedPath = path.join(options.stagingDir, stagedName(file.name));

    await mkdir(options.stagingDir, { recursive: true });
    await writeFile(stagedPath, data);

    return {
      attachment: {
        filename: file.name,
        kind: "file",
        mimeType: file.mimeType,
        path: stagedPath,
        sizeBytes: data.byteLength,
      },
      ok: true,
    };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof FileTooLargeError ? "too_large" : "download_failed",
    };
  }
};

const attachmentSize = (attachment: Attachment): number =>
  attachment.kind === "bytes"
    ? attachment.data.byteLength
    : attachment.sizeBytes;

/**
 * Throws a permanent `DeliveryError` if any attachment is larger than `maxBytes`. The binding checks every attachment
 * before it posts any part of a message, so a rejected delivery leaves nothing in the Chat.
 */
export const assertAttachmentSizes = (
  attachments: readonly Attachment[],
  maxBytes: number
): void => {
  const oversized = attachments.find(
    (attachment) => attachmentSize(attachment) > maxBytes
  );

  if (oversized !== undefined) {
    throw new DeliveryError(
      `Attachment ${oversized.filename} exceeds ${maxBytes} bytes`,
      { kind: "permanent" }
    );
  }
};

/** Uploads one outbound attachment into a Chat with `files.uploadV2`. */
export const uploadAttachment = async (
  client: SlackWebClient,
  target: SlackChatTarget,
  attachment: Attachment
): Promise<void> => {
  const file =
    attachment.kind === "bytes"
      ? Buffer.from(attachment.data)
      : attachment.path;

  const common = {
    file,
    filename: attachment.filename,
    title: attachment.filename,
  };

  await (target.threadTs === undefined
    ? client.filesUploadV2({ ...common, channel_id: target.channel })
    : client.filesUploadV2({
        ...common,
        channel_id: target.channel,
        thread_ts: target.threadTs,
      }));
};
