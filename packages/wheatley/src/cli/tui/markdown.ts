import { styleText } from "node:util";

import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";

const FENCE = /^\s*(?<marker>```|~~~)\s*(?<language>[\w+-]*)\s*$/u;
const HEADING = /^(?<hashes>#{1,6})\s+(?<text>.*)$/u;
const BULLET = /^(?<indent>\s*)[-*+]\s+(?<text>.*)$/u;
const NUMBERED = /^(?<indent>\s*)(?<number>\d+)[.)]\s+(?<text>.*)$/u;
const QUOTE = /^\s*>\s?(?<text>.*)$/u;
const RULE = /^\s*(?<mark>[-*_])(?:\s*\k<mark>){2,}\s*$/u;

const INLINE_CODE = /`(?<code>[^`]+)`/gu;
const BOLD = /\*\*(?<star>[^*]+)\*\*|__(?<under>[^_]+)__/gu;

const ITALIC =
  /(?<![\w*])\*(?<star>[^*\s][^*]*)\*(?!\*)|(?<![\w_])_(?<under>[^_\s][^_]*)_(?!\w)/gu;

const STRIKE = /~~(?<text>[^~]+)~~/gu;
const LINK = /\[(?<label>[^\]]+)\]\((?<url>[^)\s]+)\)/gu;

/** Marks a code span while the emphasis rules run. U+E000 is a private-use character that real text does not use. */
const CODE_MARK = "";
const CODE_PLACEHOLDER = /(?<index>\d+)/gu;

const RULE_WIDTH = 40;
const LEADING_SPACES = /^ */u;

/**
 * One rendered Markdown line, ready to wrap. Only `body` wraps. The first row starts with `lead`, for example a bullet
 * or a code gutter, and each continuation row starts with `hang`, so a wrapped bullet continues under its text.
 */
export interface MarkdownLine {
  readonly lead: string;
  readonly body: string;
  readonly hang: string;
}

const spaces = (text: string): string => " ".repeat(stringWidth(text));

const plainLine = (body: string): MarkdownLine => ({
  body,
  hang: "",
  lead: "",
});

/** The whole first row of a line, without wrapping. */
export const lineText = (line: MarkdownLine): string =>
  `${line.lead}${line.body}`;

const H1 = 1;
const H2 = 2;

type Groups = Readonly<Partial<Record<string, string>>>;

/** Replaces every match of `pattern` in `text` with `render` of its named groups. */
const replaceMatches = (
  text: string,
  pattern: RegExp,
  render: (groups: Groups) => string
): string => {
  let result = "";
  let last = 0;

  for (const match of text.matchAll(pattern)) {
    result += `${text.slice(last, match.index)}${render(match.groups ?? {})}`;
    last = match.index + match[0].length;
  }

  return `${result}${text.slice(last)}`;
};

/** Styles `code`, **bold**, *italic*, ~~strike~~, and [links](url) in one line. Code spans keep their content as is. */
export const renderInline = (text: string): string => {
  const codeSpans: string[] = [];

  // Code spans go out first and come back last, so emphasis rules do not touch their content.
  const withoutCode = replaceMatches(text, INLINE_CODE, ({ code }) => {
    codeSpans.push(styleText("yellow", code ?? ""));

    return `${CODE_MARK}${codeSpans.length - 1}${CODE_MARK}`;
  });

  const linked = replaceMatches(
    withoutCode,
    LINK,
    ({ label, url }) =>
      `${styleText("underline", label ?? "")} ${styleText("dim", `(${url ?? ""})`)}`
  );

  const bold = replaceMatches(linked, BOLD, ({ star, under }) =>
    styleText("bold", star ?? under ?? "")
  );

  const italic = replaceMatches(bold, ITALIC, ({ star, under }) =>
    styleText("italic", star ?? under ?? "")
  );

  const struck = replaceMatches(italic, STRIKE, ({ text: inner }) =>
    styleText("strikethrough", inner ?? "")
  );

  return replaceMatches(
    struck,
    CODE_PLACEHOLDER,
    ({ index }) => codeSpans[Number(index)] ?? ""
  );
};

const renderHeading = (level: number, text: string): string => {
  const content = renderInline(text);

  if (level === H1) {
    return styleText(["bold", "cyan", "underline"], content);
  }

  return level === H2
    ? styleText(["bold", "cyan"], content)
    : styleText("bold", content);
};

const renderListItem = (
  indent: string,
  marker: string,
  text: string
): MarkdownLine => {
  const lead = `${indent}${styleText("cyan", marker)} `;

  return {
    body: renderInline(text),
    hang: spaces(`${indent}${marker} `),
    lead,
  };
};

/** Renders one line outside a code block, or returns `undefined` if the line is plain text. */
const renderBlock = (line: string): MarkdownLine | undefined => {
  const heading = HEADING.exec(line)?.groups;

  if (heading !== undefined) {
    return plainLine(
      renderHeading(heading.hashes?.length ?? 1, heading.text ?? "")
    );
  }

  if (RULE.test(line)) {
    return plainLine(styleText("dim", "─".repeat(RULE_WIDTH)));
  }

  const bullet = BULLET.exec(line)?.groups;

  if (bullet !== undefined) {
    return renderListItem(bullet.indent ?? "", "•", bullet.text ?? "");
  }

  const numbered = NUMBERED.exec(line)?.groups;

  if (numbered !== undefined) {
    return renderListItem(
      numbered.indent ?? "",
      `${numbered.number ?? ""}.`,
      numbered.text ?? ""
    );
  }

  const quote = QUOTE.exec(line)?.groups;
  const bar = `${styleText("dim", "▎")} `;

  return quote === undefined
    ? undefined
    : {
        body: styleText("italic", renderInline(quote.text ?? "")),
        hang: bar,
        lead: bar,
      };
};

/**
 * Renders Markdown one line at a time, as a streamed reply arrives. The renderer keeps the code-fence state between
 * lines, so a code block that arrives over many deltas renders as one block.
 */
export const createMarkdownRenderer = (): ((line: string) => MarkdownLine) => {
  let fence: string | undefined;

  return (line) => {
    const opening = FENCE.exec(line)?.groups;

    if (fence !== undefined) {
      if (opening?.marker === fence) {
        fence = undefined;

        return plainLine(styleText("dim", "╰─"));
      }

      // The indentation goes into the gutter, so it stays on every row and the color codes do not hide it.
      const indent = LEADING_SPACES.exec(line)?.[0] ?? "";
      const gutter = `${styleText("dim", "│")} ${indent}`;

      return {
        body: styleText("green", line.slice(indent.length)),
        hang: gutter,
        lead: gutter,
      };
    }

    if (opening !== undefined) {
      fence = opening.marker;

      const language = opening.language ?? "";

      return plainLine(
        styleText("dim", language === "" ? "╭─" : `╭─ ${language}`)
      );
    }

    return renderBlock(line) ?? plainLine(renderInline(line));
  };
};

/** Renders a whole Markdown text for the terminal. */
export const renderMarkdown = (text: string): MarkdownLine[] => {
  const render = createMarkdownRenderer();

  return text.split("\n").map((line) => render(line));
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
