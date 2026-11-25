/*
 * Converts the Markdown of Agent replies to the HTML subset of the Telegram Bot API (`parse_mode: "HTML"`). Telegram
 * rejects unbalanced tags, so the converter only emits tags in matched pairs and escapes all other text.
 */

const FENCE_OPEN = /^ {0,3}(?<marker>`{3,}|~{3,})\s*(?<info>[^\s`]*)/u;
const HEADING = /^ {0,3}#{1,6}\s+(?<text>.*?)\s*#*\s*$/u;
const QUOTE = /^ {0,3}>\s?(?<text>.*)$/u;
const BULLET = /^(?<indent>\s*)[-*+]\s+(?<text>.*)$/u;
const INLINE_CODE = /(?<ticks>`+)(?<code>.+?)\k<ticks>/gu;
const LINK = /\[(?<label>[^\]]+)\]\((?<url>(?:https?|tg|mailto):[^)\s]+)\)/gu;
const BOLD = /(?:\*\*|__)(?=\S)(?<text>.+?)(?<=\S)(?:\*\*|__)/gu;
const ITALIC_STAR = /(?<![\w*])\*(?=\S)(?<text>[^*]+?)(?<=\S)\*(?![\w*])/gu;
const ITALIC_UNDERSCORE = /(?<![\w_])_(?=\S)(?<text>[^_]+?)(?<=\S)_(?![\w_])/gu;
const STRIKE = /~~(?=\S)(?<text>.+?)(?<=\S)~~/gu;
const PLACEHOLDER = /\uE000(?<index>\d+)\uE001/gu;

/** Escapes the three characters that Telegram HTML requires escaped, plus `"` for attribute values. */
export const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** Formats the inline Markdown of one line. Code spans and links become placeholders so later rules skip them. */
const formatInline = (line: string): string => {
  const protectedParts: string[] = [];

  const protect = (html: string): string => {
    protectedParts.push(html);

    return `\uE000${protectedParts.length - 1}\uE001`;
  };

  let text = line.replaceAll(INLINE_CODE, (_match, _ticks, code: string) =>
    protect(`<code>${escapeHtml(code)}</code>`)
  );

  text = text.replaceAll(LINK, (_match, label: string, url: string) =>
    protect(`<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`)
  );

  text = escapeHtml(text)
    .replaceAll(BOLD, "<b>$<text></b>")
    .replaceAll(STRIKE, "<s>$<text></s>")
    .replaceAll(ITALIC_STAR, "<i>$<text></i>")
    .replaceAll(ITALIC_UNDERSCORE, "<i>$<text></i>");

  return text.replaceAll(
    PLACEHOLDER,
    (_match, index: string) => protectedParts[Number(index)] ?? ""
  );
};

const formatLine = (line: string): string => {
  const heading = HEADING.exec(line)?.groups?.text;

  if (heading !== undefined) {
    return `<b>${formatInline(heading)}</b>`;
  }

  const bullet = BULLET.exec(line)?.groups;

  if (bullet?.text !== undefined) {
    return `${bullet.indent ?? ""}• ${formatInline(bullet.text)}`;
  }

  return formatInline(line);
};

const isFenceClose = (line: string, marker: string): boolean => {
  const trimmed = line.trim();

  return (
    trimmed.length >= marker.length &&
    trimmed.replaceAll(marker.charAt(0), "") === ""
  );
};

const codeBlock = (info: string, lines: readonly string[]): string => {
  const language = info === "" ? "" : ` class="language-${escapeHtml(info)}"`;

  return `<pre><code${language}>${escapeHtml(lines.join("\n"))}</code></pre>`;
};

/**
 * Converts Markdown to Telegram HTML.
 *
 * Supports fenced code blocks, inline code, links, bold, italic, strikethrough, headings (as bold), bullet lists, and
 * block quotes. Leaves other Markdown as escaped text. The visible text is never longer than the Markdown input, so a
 * chunk that fits the 4096-character limit as Markdown also fits as HTML.
 */
export const markdownToTelegramHtml = (markdown: string): string => {
  const lines = markdown.split("\n");
  const output: string[] = [];
  let quote: string[] = [];
  let index = 0;

  const endQuote = (): void => {
    if (quote.length > 0) {
      output.push(`<blockquote>${quote.join("\n")}</blockquote>`);
      quote = [];
    }
  };

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const fence = FENCE_OPEN.exec(line)?.groups;
    index += 1;

    if (fence?.marker !== undefined) {
      endQuote();
      const body: string[] = [];

      while (
        index < lines.length &&
        !isFenceClose(lines[index] ?? "", fence.marker)
      ) {
        body.push(lines[index] ?? "");
        index += 1;
      }

      index += 1;
      output.push(codeBlock(fence.info ?? "", body));
      continue;
    }

    const quoted = QUOTE.exec(line)?.groups?.text;

    if (quoted === undefined) {
      endQuote();
      output.push(formatLine(line));
    } else {
      quote.push(formatLine(quoted));
    }
  }

  endQuote();

  return output.join("\n");
};
