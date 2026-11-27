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

const ANSI = {
  blue: "\u001B[1;34m",
  bold: "\u001B[1m",
  red: "\u001B[1;31m",
  reset: "\u001B[0m",
} as const;

const LINE_BREAK = /\r?\n/u;
const INDEX_SEGMENT = /^\d+$/u;
const NON_TAB = /[^\t]/gu;

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

interface Paint {
  readonly error: (text: string) => string;
  readonly bold: (text: string) => string;
  readonly gutter: (text: string) => string;
}

const paint = (color: boolean): Paint => {
  const wrap =
    (code: string) =>
    (text: string): string =>
      color ? `${code}${text}${ANSI.reset}` : text;

  return {
    bold: wrap(ANSI.bold),
    error: wrap(ANSI.red),
    gutter: wrap(ANSI.blue),
  };
};

/** Moves an offset at the end of the text back onto the last line, so that it points after its last character. */
const clampOffset = (source: string, offset: number): number => {
  const last = source.endsWith("\n") ? source.length - 1 : source.length;

  return Math.max(0, Math.min(offset, last));
};

const renderDiagnostic = (
  diagnostic: Diagnostic,
  input: ConfigDiagnosticsInput,
  counter: LineCounter,
  lines: readonly string[]
): string => {
  const style = paint(input.color);
  const start = clampOffset(input.source, diagnostic.span[0]);
  const { line, col } = counter.linePos(start);
  const text = lines[line - 1] ?? "";
  const lineEnd = start - (col - 1) + text.trimEnd().length;
  const width = Math.max(1, Math.min(diagnostic.span[1], lineEnd) - start);

  const shown = [line - 1, line, line + 1].filter(
    (number) => number >= 1 && number <= lines.length
  );

  const gutterWidth = String(Math.max(...shown)).length;
  const blank = " ".repeat(gutterWidth);
  const bar = style.gutter(`${blank} |`);

  const sourceLine = (number: number): string =>
    `${style.gutter(`${String(number).padStart(gutterWidth)} |`)} ${lines[number - 1] ?? ""}`.trimEnd();

  // Tabs before the span stay tabs, so the carets line up under the source text.
  const indent = text.slice(0, col - 1).replaceAll(NON_TAB, " ");
  const marker = `${bar} ${indent}${style.error(`${"^".repeat(width)} ${diagnostic.label}`)}`;

  const snippet = shown.flatMap((number) =>
    number === line ? [sourceLine(number), marker] : [sourceLine(number)]
  );

  return [
    `${style.error("error")}${style.bold(`: ${diagnostic.headline}`)}`,
    `${blank}${style.gutter("-->")} ${input.file}:${line}:${col}`,
    bar,
    ...snippet,
    bar,
  ].join("\n");
};

/**
 * Renders validation issues of a YAML config file as rustc-style diagnostics: a headline, the `file:line:column`
 * location, and a source snippet with carets under the offending entry. If the text has YAML syntax errors, they
 * replace `issues`, because their positions come from the parser. Each issue path is a JSON Pointer into the YAML
 * document.
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

  const lines = input.source.split(LINE_BREAK);

  if (lines.at(-1) === "" && lines.length > 1) {
    lines.pop();
  }

  return `${diagnostics.map((diagnostic) => renderDiagnostic(diagnostic, input, counter, lines)).join("\n\n")}\n`;
};
