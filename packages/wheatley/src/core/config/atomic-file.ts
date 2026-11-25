import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

/** Reads a UTF-8 file, or resolves `undefined` if it does not exist. */
export const readTextIfExists = async (
  file: string
): Promise<string | undefined> => {
  try {
    return await readFile(file, "utf-8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
};

/**
 * Replaces `file` with `text` atomically: it writes and syncs a temporary file in the same folder, then renames it.
 * A reader sees the old or the new file, never a half-written one. `mode` applies to the new file.
 */
export const writeFileAtomic = async (
  file: string,
  text: string,
  mode: number
): Promise<void> => {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "w", mode);

  try {
    await handle.writeFile(text, "utf-8");
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
};

/** Waits for `promise` and ignores its outcome. */
const settled = async <T>(promise: Promise<T>): Promise<void> => {
  try {
    await promise;
  } catch {
    // The caller of `run` receives the error. The queue only waits for the step to end.
  }
};

/** Runs async steps one at a time, in call order. A failed step does not block later steps. */
export class SerialQueue {
  #tail: Promise<void> = Promise.resolve();

  readonly run = async <T>(step: () => Promise<T>): Promise<T> => {
    const previous = this.#tail;

    const result = (async () => {
      await previous;

      return await step();
    })();

    this.#tail = settled(result);

    return await result;
  };
}
