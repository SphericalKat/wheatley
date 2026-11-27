import { Parser } from "htmlparser2";
import TurndownService from "turndown";

/** Elements whose content never reaches the converted output. */
const OMITTED = [
  "script",
  "style",
  "noscript",
  "iframe",
  "object",
  "embed",
  "meta",
  "link",
  "template",
] as const;

const OMITTED_TAGS: ReadonlySet<string> = new Set(OMITTED);

const turndown = new TurndownService({
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
  headingStyle: "atx",
  hr: "---",
});

// Turndown parses the document inside a body element, which drops `<head>` but keeps `<title>`.
turndown.remove([...OMITTED, "title"]);

/** Converts an HTML document to Markdown. */
export const htmlToMarkdown = (html: string): string =>
  turndown.turndown(html).trim();

/** Extracts the visible text of an HTML document, without scripts, styles, and embedded content. */
export const htmlToText = (html: string): string => {
  let text = "";
  let skipDepth = 0;

  const parser = new Parser({
    onclosetag: () => {
      if (skipDepth > 0) {
        skipDepth -= 1;
      }
    },
    onopentag: (name) => {
      if (skipDepth > 0 || OMITTED_TAGS.has(name)) {
        skipDepth += 1;
      }
    },
    ontext: (value) => {
      if (skipDepth === 0) {
        text += value;
      }
    },
  });

  parser.write(html);
  parser.end();

  return text.trim();
};
