/*
 * Converts the Markdown of Agent replies to the HTML subset of the Telegram Bot API (`parse_mode: "HTML"`). Telegram
 * rejects unbalanced tags, so the converter only emits tags in matched pairs and escapes all other text.
 */

import type { Token, Tokens } from "marked";

import {
  blockTokens,
  inlineTokens,
  lexMarkdown,
} from "../../core/markdown-tokens.js";
import type { BlockToken, InlineToken } from "../../core/markdown-tokens.js";

const LINK_SCHEMES: readonly string[] = ["http:", "https:", "tg:", "mailto:"];
const LIST_INDENT = "  ";
const RULE = "———";

/** Escapes the three characters that Telegram HTML requires escaped, plus `"` for attribute values. */
export const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const isSafeLink = (href: string): boolean => {
  const lower = href.toLowerCase();

  return LINK_SCHEMES.some((scheme) => lower.startsWith(scheme));
};

const formatInlineToken = (token: InlineToken): string => {
  switch (token.type) {
    case "codespan": {
      return `<code>${escapeHtml(token.text)}</code>`;
    }

    case "strong": {
      return `<b>${formatInline(token.tokens)}</b>`;
    }

    case "em": {
      return `<i>${formatInline(token.tokens)}</i>`;
    }

    case "del": {
      return `<s>${formatInline(token.tokens)}</s>`;
    }

    case "link":
    case "image": {
      const label = formatInline(token.tokens);

      return isSafeLink(token.href)
        ? `<a href="${escapeHtml(token.href)}">${label}</a>`
        : label;
    }

    case "br": {
      return "\n";
    }

    case "text": {
      return token.tokens === undefined
        ? escapeHtml(token.text)
        : formatInline(token.tokens);
    }

    case "escape": {
      return escapeHtml(token.text);
    }

    case "html": {
      return escapeHtml(token.raw);
    }

    default: {
      return "";
    }
  }
};

const formatInline = (tokens: readonly Token[] | undefined): string =>
  inlineTokens(tokens).map(formatInlineToken).join("");

interface BlockContext {
  /** Telegram rejects a blockquote inside a blockquote, so a nested quote keeps only its content. */
  readonly inQuote: boolean;
  /** How many lists contain the block. */
  readonly listDepth: number;
}

const TOP: BlockContext = { inQuote: false, listDepth: 0 };

const codeBlock = (token: Tokens.Code): string => {
  const info = token.lang?.split(" ")[0] ?? "";
  const language = info === "" ? "" : ` class="language-${escapeHtml(info)}"`;

  return `<pre><code${language}>${escapeHtml(token.text)}</code></pre>`;
};

/**
 * The marker of a list item as the Markdown writes it. A computed number, for example `10.` for the tenth `1.`, can be
 * longer than the Markdown marker.
 */
const sourceMarker = (item: Tokens.ListItem): string =>
  item.raw.trimStart().split(" ", 1)[0] ?? "";

const formatList = (token: Tokens.List, context: BlockContext): string => {
  const indent = LIST_INDENT.repeat(context.listDepth);
  const inner = { ...context, listDepth: context.listDepth + 1 };

  return token.items
    .map((item) => {
      const marker = token.ordered ? sourceMarker(item) : "•";
      const box = item.checked === true ? "☑ " : "☐ ";
      const check = item.task ? box : "";
      const content = formatBlocks(item.tokens, inner);

      return `${indent}${marker} ${check}${content}`;
    })
    .join(token.loose ? "\n\n" : "\n");
};

const formatBlock = (
  token: BlockToken,
  context: BlockContext
): string | undefined => {
  switch (token.type) {
    case "paragraph":
    case "text": {
      return token.tokens === undefined
        ? escapeHtml(token.text)
        : formatInline(token.tokens);
    }

    case "heading": {
      return `<b>${formatInline(token.tokens)}</b>`;
    }

    case "code": {
      return codeBlock(token);
    }

    case "list": {
      return formatList(token, context);
    }

    case "blockquote": {
      const content = formatBlocks(token.tokens, { ...context, inQuote: true });

      return context.inQuote ? content : `<blockquote>${content}</blockquote>`;
    }

    case "table": {
      // Telegram has no table tags. Preformatted source text keeps the columns readable.
      return `<pre>${escapeHtml(token.raw.trimEnd())}</pre>`;
    }

    case "hr": {
      return RULE;
    }

    case "space": {
      return "";
    }

    case "def":
    case "checkbox":
    case "list_item": {
      return undefined;
    }

    case "html": {
      return escapeHtml(token.raw.trimEnd());
    }

    default: {
      return undefined;
    }
  }
};

const formatBlocks = (
  tokens: readonly Token[],
  context: BlockContext
): string =>
  blockTokens(tokens)
    .map((token) => formatBlock(token, context))
    .filter((block) => block !== undefined)
    .join("\n");

/**
 * Converts Markdown to Telegram HTML.
 *
 * Supports fenced code blocks, inline code, links, bold, italic, strikethrough, headings (as bold), lists, block
 * quotes, and tables (as preformatted text). Shows raw HTML and links with other schemes as escaped text. The visible
 * text is never longer than the Markdown input, so a chunk that fits the 4096-character limit as Markdown also fits as
 * HTML.
 */
export const markdownToTelegramHtml = (markdown: string): string =>
  formatBlocks(lexMarkdown(markdown), TOP);
