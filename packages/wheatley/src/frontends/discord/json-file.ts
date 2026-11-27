import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const isMissingFile = (cause: unknown): boolean =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

/** One JSON file in the binding's `dataDir`. Writes replace the whole file atomically, one at a time. */
export class JsonFile<T> {
  readonly #path: string;
  readonly #dataDir: string;
  readonly #isValid: (value: unknown) => value is T;
  #writes: Promise<void> = Promise.resolve();

  constructor(
    dataDir: string,
    name: string,
    isValid: (value: unknown) => value is T
  ) {
    this.#dataDir = dataDir;
    this.#path = path.join(dataDir, name);
    this.#isValid = isValid;
  }

  /**
   * Reads and parses the file. Resolves `undefined` for a missing file. Rejects for an unreadable file, invalid JSON,
   * or JSON that `isValid` rejects.
   */
  async read(): Promise<T | undefined> {
    let text: string;

    try {
      text = await readFile(this.#path, "utf-8");
    } catch (error) {
      if (isMissingFile(error)) {
        return undefined;
      }

      throw error;
    }

    const parsed: unknown = JSON.parse(text);

    if (!this.#isValid(parsed)) {
      throw new Error(`The file ${this.#path} has an unknown format`);
    }

    return parsed;
  }

  /** Replaces the file with `value` and resolves once the file holds it. */
  async write(value: T): Promise<void> {
    const snapshot = JSON.stringify(value);
    const previous = this.#writes;

    const write = async (): Promise<void> => {
      try {
        await previous;
      } catch {
        // The earlier write already rejected to its own caller. This write replaces the whole file anyway.
      }

      await mkdir(this.#dataDir, { recursive: true });
      const temporary = `${this.#path}.tmp`;
      await writeFile(temporary, snapshot);
      await rename(temporary, this.#path);
    };

    // Writes run one at a time, so a slow earlier write cannot replace a newer snapshot.
    const next = write();
    this.#writes = next;
    await next;
  }
}
