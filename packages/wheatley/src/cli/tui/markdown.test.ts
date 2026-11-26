import { stripVTControlCharacters } from "node:util";

import { expect, it } from "vitest";

import {
  createMarkdownRenderer,
  lineText,
  renderMarkdown,
  wrapLines,
} from "./markdown.js";
import type { MarkdownLine } from "./markdown.js";

const plain = (text: string): string => stripVTControlCharacters(text);

const shown = (lines: readonly MarkdownLine[]): string =>
  plain(lines.map(lineText).join("\n"));

it("renders headings, bullets, numbers, quotes, and rules as plain shapes", () => {
  const text = [
    "# Title",
    "- one",
    "  * two",
    "3. three",
    "> quoted",
    "---",
  ].join("\n");

  expect(shown(renderMarkdown(text)).split("\n")).toStrictEqual([
    "Title",
    "• one",
    "  • two",
    "3. three",
    "▎ quoted",
    "─".repeat(40),
  ]);
});

it("keeps the content of code spans and removes emphasis markers", () => {
  expect(
    shown(renderMarkdown("Use `**not bold**` and **bold**, *it*, ~~gone~~"))
  ).toBe("Use **not bold** and bold, it, gone");
});

it("shows a link label with its URL", () => {
  expect(shown(renderMarkdown("See [the docs](https://example.com/x)"))).toBe(
    "See the docs (https://example.com/x)"
  );
});

it("keeps a code block open across lines that arrive one at a time", () => {
  const render = createMarkdownRenderer();

  const lines = [
    "```ts",
    "# not a heading",
    "- not a bullet",
    "```",
    "- a bullet",
  ].map((line) => plain(lineText(render(line))));

  expect(lines).toStrictEqual([
    "╭─ ts",
    "│ # not a heading",
    "│ - not a bullet",
    "╰─",
    "• a bullet",
  ]);
});

it("wraps at word boundaries and continues a bullet under its text", () => {
  const lines = renderMarkdown(
    "- alpha beta gamma delta epsilon\nplain words that wrap here"
  );

  expect(plain(wrapLines(lines, 16)).split("\n")).toStrictEqual([
    "• alpha beta",
    "  gamma delta",
    "  epsilon",
    "plain words that",
    "wrap here",
  ]);
});

it("breaks a word only when it is longer than the line, and keeps the code gutter", () => {
  const lines = renderMarkdown("```\nabcdefghijklmnop\n```");

  expect(plain(wrapLines(lines, 10)).split("\n")).toStrictEqual([
    "╭─",
    "│ abcdefgh",
    "│ ijklmnop",
    "╰─",
  ]);
});

it("keeps code indentation on the first row and on wrapped rows", () => {
  const lines = renderMarkdown("```\n    return valueOne + valueTwo;\n```");

  expect(plain(wrapLines(lines, 24)).split("\n")).toStrictEqual([
    "╭─",
    "│     return valueOne +",
    "│     valueTwo;",
    "╰─",
  ]);
});
