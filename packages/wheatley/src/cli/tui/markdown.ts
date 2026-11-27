import { styleText } from "node:util";

import type { Token, Tokens } from "marked";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";

import {
  blockTokens,
  inlineTokens,
  lexMarkdown,
  taskBox,
  walkInlineTokens,
} from "../../core/markdown-tokens.js";
import type { BlockToken, InlineToken } from "../../core/markdown-tokens.js";

const RULE_WIDTH = 40;
const LEADING_SPACES = /^ */u;

/** Literal bracketed text, which a reference definition later in the reply can still turn into a link. */
const BRACKETED = /\[[^\]]*\]/u;

/** The source of a reference link or image, such as `[docs][1]` or `[docs]`. An inline link ends with `)` instead. */
const REFERENCE_LINK = /^!?\[[\s\S]*\]$/u;
const H1 = 1;
const H2 = 2;
const TASK_BOXES = { checked: "[x] ", unchecked: "[ ] " } as const;

/**
 * One rendered Markdown line, ready to wrap. Only `body` wraps. The first row starts with `lead`, for example a bullet
 * or a code gutter, and each continuation row starts with `hang`, so a wrapped bullet continues under its text.
 */
export interface MarkdownLine {
  readonly lead: string;
  readonly body: string;
  readonly hang: string;
}

type Style = Parameters<typeof styleText>[0];

/** Styled inline text, split into rows at its line breaks. A row never contains a newline. */
type Rows = readonly string[];

const spaces = (text: string): string => " ".repeat(stringWidth(text));

const plainLine = (body: string): MarkdownLine => ({
  body,
  hang: "",
  lead: "",
});

/** The whole first row of a line, without wrapping. */
export const lineText = (line: MarkdownLine): string =>
  `${line.lead}${line.body}`;

/** Styles each row on its own, so a style that spans a line break does not leak into the prefix of the next row. */
const style = (format: Style, rows: Rows): string[] =>
  rows.map((row) => (row === "" ? row : styleText(format, row)));

const textRows = (text: string): string[] => text.split("\n");

/** Joins inline parts. The last row of each part continues on the first row of the next part. */
const concatRows = (parts: readonly Rows[]): string[] => {
  const rows = [""];

  for (const part of parts) {
    const [first = "", ...rest] = part;

    rows[rows.length - 1] = `${rows.at(-1) ?? ""}${first}`;

    for (const row of rest) {
      rows.push(row);
    }
  }

  return rows;
};

const renderLink = (token: Tokens.Link | Tokens.Image): Rows => {
  const label = style("underline", renderInline(token.tokens));

  const plainHref =
    token.href === token.text || token.href === `mailto:${token.text}`;

  return plainHref
    ? label
    : concatRows([label, [` ${styleText("dim", `(${token.href})`)}`]]);
};

const renderInlineToken = (token: InlineToken): Rows => {
  switch (token.type) {
    case "codespan": {
      return [styleText("yellow", token.text.replaceAll("\n", " "))];
    }

    case "strong": {
      return style("bold", renderInline(token.tokens));
    }

    case "em": {
      return style("italic", renderInline(token.tokens));
    }

    case "del": {
      return style("strikethrough", renderInline(token.tokens));
    }

    case "link":
    case "image": {
      return renderLink(token);
    }

    case "br": {
      return ["", ""];
    }

    case "text": {
      return token.tokens === undefined
        ? textRows(token.text)
        : renderInline(token.tokens);
    }

    case "escape": {
      return textRows(token.text);
    }

    case "html": {
      return textRows(token.raw);
    }

    default: {
      return [];
    }
  }
};

/** Styles `code`, **bold**, *italic*, ~~strike~~, and [links](url). Code spans keep their content as is. */
const renderInline = (tokens: readonly Token[] | undefined): string[] =>
  concatRows(inlineTokens(tokens).map(renderInlineToken));

/** Puts `lead` before the first line and `hang` before every other line and every continuation row. */
const prefix = (
  lines: readonly MarkdownLine[],
  lead: string,
  hang: string
): MarkdownLine[] =>
  lines.map((line, index) => ({
    body: line.body,
    hang: `${hang}${line.hang}`,
    lead: `${index === 0 ? lead : hang}${line.lead}`,
  }));

const renderHeading = (token: Tokens.Heading): MarkdownLine[] => {
  const rows = renderInline(token.tokens);

  if (token.depth === H1) {
    return style(["bold", "cyan", "underline"], rows).map(plainLine);
  }

  return (
    token.depth === H2 ? style(["bold", "cyan"], rows) : style("bold", rows)
  ).map(plainLine);
};

const renderCode = (token: Tokens.Code): MarkdownLine[] => {
  const language = token.lang?.split(" ")[0] ?? "";
  const body = token.text === "" ? [] : token.text.split("\n");

  const rows = body.map((line): MarkdownLine => {
    // The indentation goes into the gutter, so it stays on every row and the color codes do not hide it.
    const indent = LEADING_SPACES.exec(line)?.[0] ?? "";
    const gutter = `${styleText("dim", "│")} ${indent}`;

    return {
      body: styleText("green", line.slice(indent.length)),
      hang: gutter,
      lead: gutter,
    };
  });

  return [
    plainLine(styleText("dim", language === "" ? "╭─" : `╭─ ${language}`)),
    ...rows,
    plainLine(styleText("dim", "╰─")),
  ];
};

const alignCell = (
  text: string,
  width: number,
  align: Tokens.TableCell["align"]
): string => {
  const gap = width - stringWidth(text);

  if (align === "right") {
    return `${" ".repeat(gap)}${text}`;
  }

  if (align === "center") {
    const left = Math.floor(gap / 2);

    return `${" ".repeat(left)}${text}${" ".repeat(gap - left)}`;
  }

  return `${text}${" ".repeat(gap)}`;
};

const cellText = (cell: Tokens.TableCell): string =>
  renderInline(cell.tokens).join(" ");

const renderTable = (token: Tokens.Table): MarkdownLine[] => {
  const header = token.header.map(cellText);
  const rows = token.rows.map((row) => row.map(cellText));

  const widths = header.map((text, column) =>
    Math.max(
      stringWidth(text),
      ...rows.map((row) => stringWidth(row[column] ?? ""))
    )
  );

  const line = (cells: readonly string[]): string =>
    widths
      .map((width, column) =>
        alignCell(cells[column] ?? "", width, token.align[column] ?? null)
      )
      .join(styleText("dim", " │ "));

  const rule = widths.map((width) => "─".repeat(width)).join("─┼─");

  return [
    plainLine(styleText("bold", line(header))),
    plainLine(styleText("dim", rule)),
    ...rows.map((row) => plainLine(line(row))),
  ];
};

const renderListItem = (
  item: Tokens.ListItem,
  marker: string
): MarkdownLine[] => {
  const check = taskBox(item, TASK_BOXES);
  const lead = `${styleText("cyan", marker)} ${check}`;
  const lines = renderBlocks(item.tokens);

  return prefix(
    lines.length === 0 ? [plainLine("")] : lines,
    lead,
    spaces(`${marker} ${check}`)
  );
};

const renderList = (token: Tokens.List): MarkdownLine[] => {
  const start = token.start === "" ? 1 : token.start;

  return token.items.flatMap((item, index) => {
    const marker = token.ordered ? `${start + index}.` : "•";
    const gap = token.loose && index > 0 ? [plainLine("")] : [];

    return [...gap, ...renderListItem(item, marker)];
  });
};

const renderBlockquote = (token: Tokens.Blockquote): MarkdownLine[] => {
  const bar = `${styleText("dim", "▎")} `;

  const inner = renderBlocks(token.tokens).map((line) => ({
    ...line,
    body: line.body === "" ? "" : styleText("italic", line.body),
  }));

  return prefix(inner, bar, bar);
};

const renderBlock = (token: BlockToken): MarkdownLine[] => {
  switch (token.type) {
    case "heading": {
      return renderHeading(token);
    }

    case "paragraph":
    case "text": {
      return (
        token.tokens === undefined
          ? textRows(token.text)
          : renderInline(token.tokens)
      ).map(plainLine);
    }

    case "code": {
      return renderCode(token);
    }

    case "table": {
      return renderTable(token);
    }

    case "list": {
      return renderList(token);
    }

    case "blockquote": {
      return renderBlockquote(token);
    }

    case "hr": {
      return [plainLine(styleText("dim", "─".repeat(RULE_WIDTH)))];
    }

    case "space": {
      return [plainLine("")];
    }

    case "def":
    case "checkbox":
    case "list_item": {
      return [];
    }

    case "html": {
      return textRows(token.raw.trimEnd()).map(plainLine);
    }

    default: {
      return [];
    }
  }
};

const renderBlocks = (tokens: readonly Token[]): MarkdownLine[] =>
  blockTokens(tokens).flatMap(renderBlock);

/** Renders a whole Markdown text for the terminal. */
export const renderMarkdown = (text: string): MarkdownLine[] =>
  renderBlocks(lexMarkdown(text));

/** A reply that arrives in deltas. Text of complete blocks moves to the transcript, the last block stays live. */
export interface MarkdownStream {
  /**
   * Adds a delta and returns the lines of the blocks that the delta completed. A block is complete when another block
   * follows it, so later text cannot change it.
   */
  readonly write: (delta: string) => readonly MarkdownLine[];
  /** The lines of the unfinished last block, rendered again from all of its text. */
  readonly live: () => readonly MarkdownLine[];
  /** Ends the stream and returns the lines of the unfinished last block. */
  readonly end: () => readonly MarkdownLine[];
}

const isSpace = (token: BlockToken): boolean => token.type === "space";

/**
 * True if a reference definition later in the reply, for example `[1]: url`, can still change `token`: it shows
 * bracketed text that a definition can turn into a link, or a reference link whose definition can still grow.
 */
const mayChangeWithDefinition = (token: BlockToken): boolean => {
  let found = false;

  walkInlineTokens([token], (inline) => {
    const isLiteral = inline.type === "text" && inline.tokens === undefined;
    const isLink = inline.type === "link" || inline.type === "image";

    found ||=
      (isLiteral && BRACKETED.test(inline.text)) ||
      (isLink && REFERENCE_LINK.test(inline.raw));
  });

  return found;
};

/**
 * Renders a streamed reply block by block, so tables, lists, quotes, and code fences render as whole blocks. Each
 * render lexes the whole text, so reference links resolve against every definition so far. A block with bracketed text
 * waits in the live lines until the end, because a later definition can still change it.
 */
export const createMarkdownStream = (): MarkdownStream => {
  let text = "";
  /** The number of top-level tokens of `text` that `write` returned. */
  let printed = 0;

  const unprinted = (): MarkdownLine[] =>
    lexMarkdown(text).slice(printed).flatMap(renderBlock);

  return {
    end: () => {
      const lines = unprinted();

      text = "";
      printed = 0;

      return lines;
    },
    live: unprinted,
    write: (delta) => {
      text += delta;

      const tokens = lexMarkdown(text);
      // Blank lines after the last block do not complete it. More list items or quote lines can still follow them.
      const last = tokens.findLastIndex((token) => !isSpace(token));

      const held = tokens.findIndex(
        (token, index) => index >= printed && mayChangeWithDefinition(token)
      );

      const complete = held === -1 ? last : Math.min(last, held);

      if (complete <= printed) {
        return [];
      }

      const lines = tokens.slice(printed, complete).flatMap(renderBlock);

      printed = complete;

      return lines;
    },
  };
};

/** Wraps one line. Leading spaces of the body, for example code indentation, stay on every row. */
const wrapLine = (line: MarkdownLine, width: number): string => {
  const indent = LEADING_SPACES.exec(line.body)?.[0] ?? "";
  const lead = `${line.lead}${indent}`;
  const hang = `${line.hang}${indent}`;
  const prefixWidth = Math.max(stringWidth(lead), stringWidth(hang));

  const rows = wrapAnsi(
    line.body.slice(indent.length),
    Math.max(1, width - prefixWidth),
    { hard: true, trim: true }
  ).split("\n");

  return rows
    .map((row, index) => `${index === 0 ? lead : hang}${row}`)
    .join("\n");
};

/**
 * Wraps rendered lines to `width` columns at word boundaries. A word breaks only when it is longer than the line.
 */
export const wrapLines = (
  lines: readonly MarkdownLine[],
  width: number
): string => lines.map((line) => wrapLine(line, width)).join("\n");
