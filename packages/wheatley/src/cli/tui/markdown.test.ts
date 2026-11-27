import { stripVTControlCharacters, styleText } from "node:util";

import { expect, it } from "vitest";

import { lineText, renderMarkdown, wrapLines } from "./markdown.js";
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

it("wraps at word boundaries and continues a bullet under its text", () => {
  const lines = renderMarkdown(
    "- alpha beta gamma delta epsilon\n\nplain words that wrap here"
  );

  expect(plain(wrapLines(lines, 16)).split("\n")).toStrictEqual([
    "• alpha beta",
    "  gamma delta",
    "  epsilon",
    "",
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

it("renders a table with aligned columns and a rule under the header", () => {
  const text = [
    "| Name | Qty |",
    "| :--- | --: |",
    "| apple | 3 |",
    "| `kiwi` | 12 |",
  ].join("\n");

  expect(shown(renderMarkdown(text)).split("\n")).toStrictEqual([
    "Name  │ Qty",
    "──────┼────",
    "apple │   3",
    "kiwi  │  12",
  ]);
});

it("indents nested list items under the text of their parent item", () => {
  const text = [
    "1. first",
    "   - inner a",
    "     - deeper",
    "   - inner b",
    "2. second",
  ].join("\n");

  expect(shown(renderMarkdown(text)).split("\n")).toStrictEqual([
    "1. first",
    "   • inner a",
    "     • deeper",
    "   • inner b",
    "2. second",
  ]);
});

it("keeps every line of a multi-line block quote behind the quote bar", () => {
  const text = ["> line one", "> line two", ">", "> - item"].join("\n");

  expect(shown(renderMarkdown(text)).split("\n")).toStrictEqual([
    "▎ line one",
    "▎ line two",
    "▎ ",
    "▎ • item",
  ]);
});

it("wraps a quoted line and keeps the quote bar on every row", () => {
  const lines = renderMarkdown("> alpha beta gamma delta");

  expect(plain(wrapLines(lines, 12)).split("\n")).toStrictEqual([
    "▎ alpha beta",
    "▎ gamma",
    "▎ delta",
  ]);
});

it("keeps one blank line between blocks and a code fence as one block", () => {
  const text =
    "Intro\n\n```ts\n# not a heading\n- not a bullet\n```\n- a bullet";

  expect(shown(renderMarkdown(text)).split("\n")).toStrictEqual([
    "Intro",
    "",
    "╭─ ts",
    "│ # not a heading",
    "│ - not a bullet",
    "╰─",
    "• a bullet",
  ]);
});

it("styles emphasis that spans a line break on both lines", () => {
  const [first, second] = renderMarkdown("**bold\nstill bold**");

  expect(first?.body).toBe(styleText("bold", "bold"));
  expect(second?.body).toBe(styleText("bold", "still bold"));
});
