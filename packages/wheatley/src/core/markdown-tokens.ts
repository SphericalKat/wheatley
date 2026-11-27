import { Marked } from "marked";
import type { MarkedToken, Token } from "marked";

/**
 * GitHub Flavored Markdown, with `breaks` so a single newline in a reply stays a line break. The instance is private,
 * so no other code can change its options or extensions.
 */
const parser = new Marked({ breaks: true, gfm: true });

const INLINE_TYPES = [
  "br",
  "codespan",
  "del",
  "em",
  "escape",
  "html",
  "image",
  "link",
  "strong",
  "text",
] as const satisfies readonly MarkedToken["type"][];

const BLOCK_TYPES = [
  "blockquote",
  "checkbox",
  "code",
  "def",
  "heading",
  "hr",
  "html",
  "list",
  "list_item",
  "paragraph",
  "space",
  "table",
  "text",
] as const satisfies readonly MarkedToken["type"][];

/** A token inside a block, for example emphasis or a link. */
export type InlineToken = Extract<
  MarkedToken,
  { type: (typeof INLINE_TYPES)[number] }
>;

/** A block token, for example a paragraph, a list, or a code block. */
export type BlockToken = Extract<
  MarkedToken,
  { type: (typeof BLOCK_TYPES)[number] }
>;

const INLINE_SET: ReadonlySet<string> = new Set(INLINE_TYPES);
const BLOCK_SET: ReadonlySet<string> = new Set(BLOCK_TYPES);

// Without extensions, the lexer emits only built-in tokens. The guards also drop the generic token type of extensions.
const isInline = (token: Token): token is InlineToken =>
  INLINE_SET.has(token.type);

const isBlock = (token: Token): token is BlockToken =>
  BLOCK_SET.has(token.type);

/** The inline tokens of a token list. */
export const inlineTokens = (
  tokens: readonly Token[] | undefined
): InlineToken[] => (tokens ?? []).filter(isInline);

/** The block tokens of a token list. */
export const blockTokens = (tokens: readonly Token[]): BlockToken[] =>
  tokens.filter(isBlock);

/** Splits Markdown into its top-level block tokens. The `raw` texts of the tokens join to the input, with `\n` line ends. */
export const lexMarkdown = (markdown: string): BlockToken[] =>
  blockTokens(parser.lexer(markdown));
