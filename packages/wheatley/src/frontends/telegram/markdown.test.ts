import { expect, it } from "vitest";

import { markdownToTelegramHtml } from "./markdown.js";

const TAG = /<[^>]+>/gu;

/** The text that Telegram shows for an HTML message. */
const visibleText = (html: string): string =>
  html
    .replaceAll(TAG, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");

it("converts a fenced code block with its language and escapes the code", () => {
  expect(markdownToTelegramHtml("```ts\nconst x = 1 < 2;\n```")).toBe(
    '<pre><code class="language-ts">const x = 1 &lt; 2;</code></pre>'
  );
});

it("converts inline code and links and escapes text and attribute values", () => {
  expect(
    markdownToTelegramHtml("Use `a < b` and [docs](https://x.dev?a=1&b=2)")
  ).toBe(
    'Use <code>a &lt; b</code> and <a href="https://x.dev?a=1&amp;b=2">docs</a>'
  );
});

it("converts headings to bold and nests emphasis", () => {
  expect(markdownToTelegramHtml("# Title *it*\n**b** _i_ ~~s~~")).toBe(
    "<b>Title <i>it</i></b>\n<b>b</b> <i>i</i> <s>s</s>"
  );
});

it("indents nested list items and keeps ordered markers", () => {
  expect(markdownToTelegramHtml("- a\n  - **b**\n\n1. c\n2. d")).toBe(
    "• a\n  • <b>b</b>\n\n1. c\n2. d"
  );
});

it("keeps a multi-line block quote in one blockquote and flattens a nested one", () => {
  expect(markdownToTelegramHtml("> one\n> two\n>> three\n\nafter")).toBe(
    "<blockquote>one\ntwo\nthree</blockquote>\n\nafter"
  );
});

it("shows raw HTML, unsafe links, and unmatched markers as escaped text", () => {
  expect(
    markdownToTelegramHtml(
      '<b onclick="x">hi</b> [bad](javascript:alert(1)) **open `tick'
    )
  ).toBe("&lt;b onclick=&quot;x&quot;&gt;hi&lt;/b&gt; bad **open `tick");
});

it("shows a table as preformatted source text", () => {
  expect(markdownToTelegramHtml("| a | b |\n| - | - |\n| 1 | <2> |")).toBe(
    "<pre>| a | b |\n| - | - |\n| 1 | &lt;2&gt; |</pre>"
  );
});

it("never shows more text than the Markdown has, so a chunk that fits as Markdown fits as HTML", () => {
  const samples = [
    "1. a\n1. b\n1. c\n1. d\n1. e\n1. f\n1. g\n1. h\n1. i\n1. j\n1. k",
    "- [ ] todo\n- [x] done",
    "| x | y |\n|-|-|\n| 1 | 2 |\n| 3 | 4 |",
    "> a\n> > b\n> c",
    "Line one\nline two  \nline three",
    "***\n\n---",
    "<https://a.b> x@y.z ![alt](https://img)",
    "Setext\n===\n\n\\*not em\\*",
  ];

  for (const markdown of samples) {
    expect(
      visibleText(markdownToTelegramHtml(markdown)).length
    ).toBeLessThanOrEqual(markdown.length);
  }
});
