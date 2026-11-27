import { styleText } from "node:util";

import { codeFrameColumns } from "@babel/code-frame";
import type { ConfigIssue } from "@wheatley-ai/protocol";
import {
  isMap,
  isNode,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
} from "yaml";
import type { Document, Node, Pair } from "yaml";

/** A half-open range of character offsets in the source text. */
type Span = readonly [start: number, end: number];

/** One problem to render, with the source span that it points at. */
interface Diagnostic {
  readonly headline: string;
  readonly span: Span;
  readonly label: string;
}

/** The input of `renderConfigDiagnostics`. */
export interface ConfigDiagnosticsInput {
  /** The path of the file to show in the location line. */
  readonly file: string;
  /** The text of the file. */
  readonly source: string;
  /** The issues that validation reported for `source`. */
  readonly issues: readonly ConfigIssue[];
  /** True to add ANSI colors. */
  readonly color: boolean;
}

const LINE_BREAK = /\r?\n/u;
const INDEX_SEGMENT = /^\d+$/u;
const TRAILING_LINE_BREAK = /\r?\n$/u;

/** The source lines that the code frame shows above and below the line of the span. */
const CONTEXT_LINES = 1;

/** Decodes a JSON Pointer such as `/agents/home/model` into its segments. */
const pointerSegments = (pointer: string): string[] =>
  pointer === "/" || pointer === ""
    ? []
    : pointer
        .slice(1)
        .split("/")
        .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));

const nodeSpan = (node: Node): Span => {
  const [start, valueEnd] = node.range ?? [0, 0];

  return [start, valueEnd];
};

/** A map entry whose key is a node. */
type KeyedPair = Pair & { readonly key: Node };

/** True for a value that starts on the line after its key, such as a block map or a block sequence. */
const isBlockCollection = (node: Node): boolean =>
  (isMap(node) || isSeq(node)) && node.flow !== true;

/** The span of a map entry: the key and a value on the same line, or only the key for a block collection value. */
const pairSpan = (pair: KeyedPair): Span => {
  const [start, keyEnd] = nodeSpan(pair.key);

  if (!isNode(pair.value) || isBlockCollection(pair.value)) {
    return [start, keyEnd];
  }

  return [start, Math.max(keyEnd, nodeSpan(pair.value)[1])];
};

const findPair = (
  items: readonly Pair[],
  segment: string
): KeyedPair | undefined =>
  items.find(
    (pair): pair is KeyedPair =>
      isScalar(pair.key) && String(pair.key.value) === segment
  );

/**
 * Resolves a JSON Pointer against the YAML AST. If a segment does not exist, for example a missing required field, the
 * span is the deepest entry that exists: the parent key, sequence item, or the start of the document.
 */
const pointerSpan = (doc: Document, pointer: string): Span => {
  let node: unknown = doc.contents;
  let span: Span = isNode(node) ? nodeSpan(node) : [0, 0];

  for (const segment of pointerSegments(pointer)) {
    if (isMap(node)) {
      const pair = findPair(node.items, segment);

      if (pair === undefined) {
        break;
      }

      span = pairSpan(pair);
      node = pair.value;
    } else if (isSeq(node) && INDEX_SEGMENT.test(segment)) {
      const item: unknown = node.items[Number(segment)];

      if (!isNode(item)) {
        break;
      }

      span = nodeSpan(item);
      node = item;
    } else {
      break;
    }
  }

  return span;
};

const syntaxDiagnostics = (doc: Document): Diagnostic[] =>
  doc.errors.map((error) => ({
    headline: "invalid YAML syntax",
    label: error.message,
    span: error.pos,
  }));

const issueDiagnostics = (
  doc: Document,
  issues: readonly ConfigIssue[]
): Diagnostic[] =>
  issues.map((issue) => ({
    headline: `invalid value at ${issue.path}`,
    label: issue.message,
    span: pointerSpan(doc, issue.path),
  }));

/** Moves an offset at the end of the text back onto the last line, so that it points after its last character. */
const clampOffset = (source: string, offset: number): number => {
  const last = source.endsWith("\n") ? source.length - 1 : source.length;

  return Math.max(0, Math.min(offset, last));
};

/** Applies a `styleText` format if `color` is true. */
const paint = (
  color: boolean,
  format: Parameters<typeof styleText>[0],
  text: string
): string =>
  color ? styleText(format, text, { validateStream: false }) : text;

const renderDiagnostic = (
  diagnostic: Diagnostic,
  input: ConfigDiagnosticsInput,
  counter: LineCounter,
  lines: readonly string[]
): string => {
  const start = clampOffset(input.source, diagnostic.span[0]);
  const { line, col } = counter.linePos(start);
  const lineEnd = start - (col - 1) + (lines[line - 1] ?? "").trimEnd().length;
  const width = Math.max(0, Math.min(diagnostic.span[1], lineEnd) - start);

  // `codeFrameColumns` takes 0-based columns and colors only with `forceColor`, so the caller decides on color.
  const frame = codeFrameColumns(
    input.source.replace(TRAILING_LINE_BREAK, ""),
    {
      end: { column: col - 1 + width, line },
      start: { column: col - 1, line },
    },
    {
      forceColor: input.color,
      linesAbove: CONTEXT_LINES,
      linesBelow: CONTEXT_LINES,
      message: diagnostic.label,
    }
  );

  const gutterWidth = String(
    Math.min(line + CONTEXT_LINES, lines.length)
  ).length;

  return [
    `${paint(input.color, ["red", "bold"], "error")}${paint(input.color, "bold", `: ${diagnostic.headline}`)}`,
    `${" ".repeat(gutterWidth + 1)}${paint(input.color, "gray", "-->")} ${input.file}:${line}:${col}`,
    frame,
  ].join("\n");
};

/**
 * Renders validation issues of a YAML config file as rustc-style diagnostics: a headline, the `file:line:column`
 * location, and a code frame with carets under the offending entry. If the text has YAML syntax errors, they replace
 * `issues`, because their positions come from the parser. Each issue path is a JSON Pointer into the YAML document.
 */
export const renderConfigDiagnostics = (
  input: ConfigDiagnosticsInput
): string => {
  const counter = new LineCounter();

  const doc = parseDocument(input.source, {
    lineCounter: counter,
    prettyErrors: false,
  });

  const diagnostics =
    doc.errors.length > 0
      ? syntaxDiagnostics(doc)
      : issueDiagnostics(doc, input.issues);

  const lines = input.source.replace(TRAILING_LINE_BREAK, "").split(LINE_BREAK);

  return `${diagnostics.map((diagnostic) => renderDiagnostic(diagnostic, input, counter, lines)).join("\n\n")}\n`;
};
