import { chunkMarkdown } from "@wheatley/sdk";
import { describe, expect, it } from "vitest";

const LIMIT = 40;

describe("chunkMarkdown", () => {
  it("returns short text as one chunk", () => {
    expect(chunkMarkdown("hello", LIMIT)).toStrictEqual(["hello"]);
  });

  it("breaks between paragraphs before it breaks lines", () => {
    const first = "First paragraph with some words.";
    const second = "Second paragraph also.";

    expect(chunkMarkdown(`${first}\n\n${second}`, LIMIT)).toStrictEqual([
      first,
      second,
    ]);
  });

  it("breaks a long line at a space and keeps every chunk within the limit", () => {
    const words = Array.from({ length: 30 }, (_, index) => `word${index}`).join(
      " "
    );

    const chunks = chunkMarkdown(words, LIMIT);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= LIMIT)).toBe(true);
    expect(chunks.join(" ")).toBe(words);
  });

  it("closes and reopens a code fence across chunks", () => {
    const code = Array.from(
      { length: 8 },
      (_, index) => `const value${index} = ${index};`
    );

    const text = ["```ts", ...code, "```"].join("\n");
    const chunks = chunkMarkdown(text, 80);

    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(80);
      expect(chunk.startsWith("```ts\n")).toBe(true);
      expect(chunk.endsWith("\n```")).toBe(true);
    }

    const body = chunks.flatMap((chunk) => chunk.split("\n").slice(1, -1));
    expect(body).toStrictEqual(code);
  });

  it("does not split a surrogate pair", () => {
    const text = "😀".repeat(40);
    const chunks = chunkMarkdown(text, 33);

    expect(chunks.join("")).toBe(text);
    expect(chunks.every((chunk) => !chunk.endsWith("\uD83D"))).toBe(true);
  });

  it("rejects a limit that leaves no room for fences", () => {
    expect(() => chunkMarkdown("text", 10)).toThrow(RangeError);
  });
});
