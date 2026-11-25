import type {
  MemoryBudget,
  MemoryFile,
  MemorySearchHit,
} from "@wheatley/protocol";

import { SeamError } from "./errors.js";
import { simulateIo } from "./fake-io.js";
import type {
  ArchivedMessage,
  MemorySearchOptions,
  MemorySnapshot,
  MemoryStore,
} from "./memory-store.js";
import { systemClock } from "./module.js";
import type { Clock } from "./module.js";

/** The default `MEMORY.md` character cap. */
export const DEFAULT_MEMORY_MAX_CHARS = 4000;

/** The flush prompt of the fake. */
export const FAKE_FLUSH_PROMPT =
  "Save durable facts from this Conversation to Memory before it compacts.";

const MEMORY = "MEMORY";
const NAME = /^(?:MEMORY|[a-z0-9][a-z0-9-]{0,63})$/u;

const assertName = (name: string): void => {
  if (!NAME.test(name)) {
    throw new SeamError("invalid_name", `Invalid Memory name: ${name}`);
  }
};

const occurrences = (text: string, query: string): number =>
  text.toLowerCase().split(query.toLowerCase()).length - 1;

interface StoredFile {
  readonly content: string;
  readonly updatedAt: number;
}

const metadataOf = (name: string, file: StoredFile): MemoryFile => ({
  chars: file.content.length,
  name,
  updatedAt: new Date(file.updatedAt).toISOString(),
});

/** An in-memory `MemoryStore`. Search counts case-insensitive occurrences of the whole query. */
export class InMemoryMemoryStore implements MemoryStore {
  readonly #files = new Map<string, StoredFile>();
  readonly #archive: ArchivedMessage[] = [];
  readonly #maxChars: number;
  readonly #clock: Clock;
  readonly #flushPrompt: string | undefined;

  constructor(
    maxChars: number = DEFAULT_MEMORY_MAX_CHARS,
    clock: Clock = systemClock,
    flushPrompt: string | undefined = FAKE_FLUSH_PROMPT
  ) {
    this.#maxChars = maxChars;
    this.#clock = clock;
    this.#flushPrompt = flushPrompt;
  }

  readonly snapshot = async (): Promise<MemorySnapshot> => {
    await simulateIo();
    const text = this.#files.get(MEMORY)?.content ?? "";

    return {
      text: text.slice(0, this.#maxChars),
      truncated: text.length > this.#maxChars,
    };
  };

  readonly list = async (): Promise<{
    readonly files: readonly MemoryFile[];
    readonly budget: MemoryBudget;
  }> => {
    await simulateIo();

    const files = [...this.#files.entries()].map(([name, file]) =>
      metadataOf(name, file)
    );

    return {
      budget: {
        maxChars: this.#maxChars,
        usedChars: this.#files.get(MEMORY)?.content.length ?? 0,
      },
      files,
    };
  };

  readonly read = async (name: string): Promise<string | undefined> => {
    await simulateIo();
    assertName(name);

    return this.#files.get(name)?.content;
  };

  readonly write = async (
    name: string,
    content: string,
    mode: "replace" | "append"
  ): Promise<MemoryFile> => {
    await simulateIo();
    assertName(name);
    const previous = this.#files.get(name)?.content ?? "";

    const next =
      mode === "append" && previous !== ""
        ? `${previous}\n${content}`
        : content;

    if (name === MEMORY && next.length > this.#maxChars) {
      throw new SeamError(
        "memory_budget_exceeded",
        `MEMORY.md would have ${next.length} characters; the cap is ${this.#maxChars}. Move details into a topic file.`
      );
    }

    const file = { content: next, updatedAt: this.#clock.now() };
    this.#files.set(name, file);

    return metadataOf(name, file);
  };

  readonly delete = async (name: string): Promise<boolean> => {
    await simulateIo();
    assertName(name);

    if (!this.#files.has(name)) {
      return false;
    }

    if (name === MEMORY) {
      this.#files.set(MEMORY, { content: "", updatedAt: this.#clock.now() });
    } else {
      this.#files.delete(name);
    }

    return true;
  };

  readonly search = async (
    query: string,
    options: MemorySearchOptions
  ): Promise<readonly MemorySearchHit[]> => {
    await simulateIo();
    const hits: MemorySearchHit[] = [];

    if (options.scope !== "conversations") {
      for (const [name, file] of this.#files) {
        const score = occurrences(file.content, query);

        if (score > 0) {
          hits.push({
            kind: "memory",
            name,
            score,
            snippet: file.content.slice(0, 200),
          });
        }
      }
    }

    if (options.scope !== "memory") {
      for (const message of this.#archive) {
        const score = occurrences(message.text, query);

        if (score > 0) {
          hits.push({
            at: new Date(message.at).toISOString(),
            conversationId: message.conversationId,
            kind: "conversation",
            role: message.role,
            score,
            snippet: message.text.slice(0, 200),
          });
        }
      }
    }

    return hits
      .toSorted((left, right) => right.score - left.score)
      .slice(0, options.limit);
  };

  readonly archive = async (message: ArchivedMessage): Promise<void> => {
    await simulateIo();
    this.#archive.push(message);
  };

  readonly purgeConversation = async (
    conversationId: string
  ): Promise<number> => {
    await simulateIo();
    const before = this.#archive.length;

    const kept = this.#archive.filter(
      (message) => message.conversationId !== conversationId
    );

    this.#archive.splice(0, this.#archive.length, ...kept);

    return before - kept.length;
  };

  readonly reindex = async (): Promise<number> => {
    await simulateIo();

    return this.#files.size;
  };

  readonly compactionFlushPrompt = (): string | undefined => this.#flushPrompt;
}
