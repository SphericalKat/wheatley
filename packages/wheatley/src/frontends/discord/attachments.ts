import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Attachment } from "@wheatley-ai/sdk";
import { DeliveryError } from "@wheatley-ai/sdk";
import type { AttachmentPayload } from "discord.js";

import { errorText } from "./errors.js";

/** Discord accepts at most this many files in one message. */
export const MAX_FILES_PER_MESSAGE = 10;

const MAX_STAGED_NAME_LENGTH = 100;
const UNSAFE_FILENAME_CHARACTERS = /[^\w.-]+/gu;
const DEFAULT_MIME_TYPE = "application/octet-stream";

/** The fields of a Discord message attachment that the binding reads. */
export interface InboundFile {
  readonly id: string;
  readonly name: string;
  readonly contentType: string | null;
  readonly size: number;
  readonly url: string;
}

/** Where and how to stage inbound files. */
export interface StagingOptions {
  readonly stagingDir: string;
  readonly maxBytes: number;
  /** A unique prefix for the staged file names of one message, for example `discord-<message_id>`. */
  readonly prefix: string;
  readonly fetch: typeof fetch;
}

/** The result of `stageInboundFiles`. */
export interface StagedFiles {
  readonly attachments: readonly Attachment[];
  /** One line for each file that the binding did not stage, so that the Agent knows about it. */
  readonly notes: readonly string[];
}

const safeName = (name: string): string => {
  const cleaned = name
    .replaceAll(UNSAFE_FILENAME_CHARACTERS, "_")
    .slice(-MAX_STAGED_NAME_LENGTH);

  return cleaned === "" ? "file" : cleaned;
};

const readCapped = async (
  response: Response,
  maxBytes: number
): Promise<Uint8Array | undefined> => {
  const chunks: Uint8Array[] = [];
  let total = 0;

  if (response.body === null) {
    return new Uint8Array();
  }

  for await (const chunk of response.body) {
    total += chunk.byteLength;

    if (total > maxBytes) {
      await response.body.cancel();

      return undefined;
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
};

type StageResult =
  | { readonly kind: "staged"; readonly attachment: Attachment }
  | { readonly kind: "skipped"; readonly note: string };

const skipped = (file: InboundFile, reason: string): StageResult => ({
  kind: "skipped",
  note: `[Attachment ${file.name} was not received: ${reason}]`,
});

const download = async (
  file: InboundFile,
  options: StagingOptions
): Promise<StageResult> => {
  const tooLarge = `it exceeds the ${options.maxBytes}-byte limit`;

  if (file.size > options.maxBytes) {
    return skipped(file, tooLarge);
  }

  const response = await options.fetch(file.url);

  if (!response.ok) {
    return skipped(file, `download failed with HTTP ${response.status}`);
  }

  const data = await readCapped(response, options.maxBytes);

  if (data === undefined) {
    return skipped(file, tooLarge);
  }

  const target = path.join(
    options.stagingDir,
    `${options.prefix}-${file.id}-${safeName(file.name)}`
  );

  await writeFile(target, data);

  return {
    attachment: {
      filename: file.name,
      kind: "file",
      mimeType: file.contentType ?? DEFAULT_MIME_TYPE,
      path: target,
      sizeBytes: data.byteLength,
    },
    kind: "staged",
  };
};

const stageOne = async (
  file: InboundFile,
  options: StagingOptions
): Promise<StageResult> => {
  try {
    return await download(file, options);
  } catch (error) {
    return skipped(file, `download failed: ${errorText(error)}`);
  }
};

/**
 * Downloads the files of one inbound message into the staging directory, one file at a time.
 *
 * Skips each file that is larger than `maxBytes`, by its declared size or by the bytes that arrive, and each file that
 * fails to download. It reports skipped files in `notes` instead of throwing, so that the message text still reaches
 * the Agent.
 */
export const stageInboundFiles = async (
  files: Iterable<InboundFile>,
  options: StagingOptions
): Promise<StagedFiles> => {
  const pending = [...files];
  const attachments: Attachment[] = [];
  const notes: string[] = [];

  if (pending.length === 0) {
    return { attachments, notes };
  }

  await mkdir(options.stagingDir, { recursive: true });

  for (const file of pending) {
    // oxlint-disable-next-line no-await-in-loop -- One download at a time keeps at most one file in memory.
    const result = await stageOne(file, options);

    if (result.kind === "staged") {
      attachments.push(result.attachment);
    } else {
      notes.push(result.note);
    }
  }

  return { attachments, notes };
};

const sizeOf = (attachment: Attachment): number =>
  attachment.kind === "bytes"
    ? attachment.data.byteLength
    : attachment.sizeBytes;

/**
 * Converts outbound attachments into Discord upload payloads.
 *
 * Throws a `permanent` `DeliveryError` if a file is larger than `maxBytes`, because a retry cannot make it fit.
 */
export const toUploadPayloads = (
  attachments: readonly Attachment[],
  maxBytes: number
): AttachmentPayload[] =>
  attachments.map((attachment) => {
    if (sizeOf(attachment) > maxBytes) {
      throw new DeliveryError(
        `Attachment ${attachment.filename} exceeds the ${maxBytes}-byte limit`,
        { kind: "permanent" }
      );
    }

    return {
      attachment:
        attachment.kind === "bytes"
          ? Buffer.from(attachment.data)
          : attachment.path,
      name: attachment.filename,
    };
  });
