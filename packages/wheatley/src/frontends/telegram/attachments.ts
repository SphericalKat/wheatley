import { randomUUID } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import path from "node:path";

import type { Attachment } from "@wheatley-ai/sdk";

import type {
  TelegramClient,
  TelegramFile,
  TelegramMessage,
  TelegramUpload,
  UploadKind,
} from "./client.js";

/** Telegram sends photos larger than this as documents only. */
const MAX_PHOTO_BYTES = 10_000_000;

const BYTES_PER_MIB = 1_048_576;

const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const UNSAFE_FILENAME = /[^\w.-]+/gu;

/** A file that a Telegram message carries, before download. */
interface IncomingFile {
  readonly fileId: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number | undefined;
}

const fromFile = (
  file: TelegramFile | undefined,
  fallbackName: string,
  fallbackType: string
): IncomingFile[] =>
  file === undefined
    ? []
    : [
        {
          fileId: file.file_id,
          filename: file.file_name ?? fallbackName,
          mimeType: file.mime_type ?? fallbackType,
          sizeBytes: file.file_size,
        },
      ];

/** Lists the files of a message. A photo contributes its largest size only. */
export const incomingFiles = (message: TelegramMessage): IncomingFile[] => {
  const id = message.message_id;
  const photo = message.photo?.at(-1);

  // Telegram also sets `document` on an animation message, with the same file.
  const document =
    message.animation === undefined ? message.document : undefined;

  return [
    ...(photo === undefined
      ? []
      : [
          {
            fileId: photo.file_id,
            filename: `photo-${id}.jpg`,
            mimeType: "image/jpeg",
            sizeBytes: photo.file_size,
          },
        ]),
    ...fromFile(document, `document-${id}`, "application/octet-stream"),
    ...fromFile(message.animation, `animation-${id}.mp4`, "video/mp4"),
    ...fromFile(message.audio, `audio-${id}.mp3`, "audio/mpeg"),
    ...fromFile(message.voice, `voice-${id}.ogg`, "audio/ogg"),
    ...fromFile(message.video, `video-${id}.mp4`, "video/mp4"),
    ...fromFile(message.video_note, `video-note-${id}.mp4`, "video/mp4"),
  ];
};

/** The result of staging the files of one message. */
export interface StagedFiles {
  readonly attachments: readonly Attachment[];
  /** The names of files that exceed the attachment limit. */
  readonly tooLarge: readonly string[];
}

class AttachmentTooLargeError extends Error {
  override readonly name = "AttachmentTooLargeError";
}

const writeCapped = async (
  chunks: AsyncIterable<Uint8Array>,
  filePath: string,
  maxBytes: number
): Promise<number> => {
  const handle = await open(filePath, "wx");
  let size = 0;

  try {
    for await (const chunk of chunks) {
      size += chunk.byteLength;

      if (size > maxBytes) {
        throw new AttachmentTooLargeError(`File exceeds ${maxBytes} bytes`);
      }

      await handle.write(chunk);
    }
  } catch (error) {
    await handle.close();
    await unlink(filePath);
    throw error;
  }

  await handle.close();

  return size;
};

/**
 * Downloads the files of a message into `stagingDir`, at most `maxBytes` each.
 *
 * A file over the limit, by its declared size or by its downloaded bytes, goes to `tooLarge` and leaves no file
 * behind. Rejects with the client error if a download fails for another reason.
 */
export const stageIncomingFiles = async (
  client: TelegramClient,
  files: readonly IncomingFile[],
  stagingDir: string,
  maxBytes: number
): Promise<StagedFiles> => {
  const attachments: Attachment[] = [];
  const tooLarge: string[] = [];

  for (const file of files) {
    if (file.sizeBytes !== undefined && file.sizeBytes > maxBytes) {
      tooLarge.push(file.filename);
      continue;
    }

    const safeName = path
      .basename(file.filename)
      .replaceAll(UNSAFE_FILENAME, "_");

    const stagedPath = path.join(stagingDir, `${randomUUID()}-${safeName}`);

    try {
      // oxlint-disable-next-line no-await-in-loop -- Files download one at a time to bound memory and disk use.
      const chunks = await client.downloadFile(file.fileId);
      // oxlint-disable-next-line no-await-in-loop -- See above.
      const sizeBytes = await writeCapped(chunks, stagedPath, maxBytes);

      attachments.push({
        filename: file.filename,
        kind: "file",
        mimeType: file.mimeType,
        path: stagedPath,
        sizeBytes,
      });
    } catch (error) {
      if (!(error instanceof AttachmentTooLargeError)) {
        throw error;
      }

      tooLarge.push(file.filename);
    }
  }

  return { attachments, tooLarge };
};

/** The notice for files that exceed the attachment limit, for example `Skipped a.bin: files over 10 MiB are not supported.` */
export const skippedFilesText = (
  filenames: readonly string[],
  maxBytes: number
): string => {
  const limit =
    maxBytes >= BYTES_PER_MIB
      ? `${Math.floor(maxBytes / BYTES_PER_MIB)} MiB`
      : `${maxBytes} bytes`;

  return `Skipped ${filenames.join(", ")}: files over ${limit} are not supported.`;
};

/** The size of an outbound attachment in bytes. */
export const attachmentSize = (attachment: Attachment): number =>
  attachment.kind === "bytes"
    ? attachment.data.byteLength
    : attachment.sizeBytes;

/** An outbound attachment as Telegram receives it. */
export interface OutboundUpload {
  readonly kind: UploadKind;
  readonly file: TelegramUpload;
}

/** Converts an outbound attachment to an upload: a photo for small JPEG, PNG, and WebP images, else a document. */
export const toUpload = (attachment: Attachment): OutboundUpload => {
  const isPhoto =
    PHOTO_TYPES.has(attachment.mimeType) &&
    attachmentSize(attachment) <= MAX_PHOTO_BYTES;

  const file: TelegramUpload =
    attachment.kind === "bytes"
      ? { data: attachment.data, filename: attachment.filename }
      : { filename: attachment.filename, path: attachment.path };

  return { file, kind: isPhoto ? "photo" : "document" };
};
