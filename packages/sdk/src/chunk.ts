/** The smallest `maxLength` that `chunkMarkdown` accepts. Smaller limits leave no room for code fences. */
export const MIN_CHUNK_LENGTH = 32;

const FENCE_OPEN = /^ {0,3}(?<marker>`{3,}|~{3,})/u;
const BLANK_LINE = /^\s*$/u;
const MAX_BMP_CODE_POINT = 0xff_ff;

/** Below this many code units per chunk for code lines, a fence costs more than it helps. */
const MIN_CODE_BUDGET = 8;

interface CodeBlock {
  readonly kind: "code";
  readonly opener: string;
  readonly closer: string;
  readonly lines: readonly string[];
}

interface TextBlock {
  readonly kind: "text";
  readonly lines: readonly string[];
}

type Block = CodeBlock | TextBlock;

const isFenceClose = (line: string, marker: string): boolean => {
  const trimmed = line.trim();

  const fenceCharacter = marker.charAt(0);

  return (
    trimmed.length >= marker.length &&
    trimmed.replaceAll(fenceCharacter, "") === ""
  );
};

const renderBlock = (block: Block): string =>
  block.kind === "text"
    ? block.lines.join("\n")
    : [
        block.opener,
        ...block.lines,
        ...(block.closer === "" ? [] : [block.closer]),
      ].join("\n");

const parseBlocks = (text: string): Block[] => {
  const blocks: Block[] = [];
  const lines = text.split("\n");
  let paragraph: string[] = [];
  let index = 0;

  const endParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "text", lines: paragraph });
      paragraph = [];
    }
  };

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const marker = FENCE_OPEN.exec(line)?.groups?.marker;

    if (marker !== undefined) {
      endParagraph();
      const body: string[] = [];
      let closer = "";
      index += 1;

      while (index < lines.length) {
        const inner = lines[index] ?? "";
        index += 1;

        if (isFenceClose(inner, marker)) {
          closer = inner;
          break;
        }

        body.push(inner);
      }

      blocks.push({ closer, kind: "code", lines: body, opener: line });
    } else if (BLANK_LINE.test(line)) {
      endParagraph();
      index += 1;
    } else {
      paragraph.push(line);
      index += 1;
    }
  }

  endParagraph();

  return blocks;
};

/** Cuts at `limit` code units, one earlier if the cut would split a surrogate pair. */
const safeCut = (text: string, limit: number): number => {
  const splitsPair = (text.codePointAt(limit - 1) ?? 0) > MAX_BMP_CODE_POINT;

  return splitsPair && limit > 1 ? limit - 1 : limit;
};

/** Splits one line into pieces of at most `limit` code units, at the last space when possible. */
const splitLine = (line: string, limit: number): string[] => {
  const pieces: string[] = [];
  let rest = line;

  while (rest.length > limit) {
    const space = rest.lastIndexOf(" ", limit);
    const cut = space > 0 ? space : safeCut(rest, limit);
    pieces.push(rest.slice(0, cut));
    rest = space > 0 ? rest.slice(cut + 1) : rest.slice(cut);
  }

  pieces.push(rest);

  return pieces;
};

/** Packs lines into groups whose newline-joined length is at most `limit`. */
const packLines = (lines: readonly string[], limit: number): string[][] => {
  const groups: string[][] = [];
  let group: string[] = [];
  let groupLength = 0;

  for (const line of lines.flatMap((entry) => splitLine(entry, limit))) {
    const added =
      group.length === 0 ? line.length : groupLength + 1 + line.length;

    if (added > limit && group.length > 0) {
      groups.push(group);
      group = [line];
      groupLength = line.length;
    } else {
      group.push(line);
      groupLength = added;
    }
  }

  if (group.length > 0) {
    groups.push(group);
  }

  return groups;
};

const splitBlock = (block: Block, maxLength: number): string[] => {
  if (block.kind === "text") {
    return packLines(block.lines, maxLength).map((group) => group.join("\n"));
  }

  const marker = FENCE_OPEN.exec(block.opener)?.groups?.marker ?? "```";
  const budget = maxLength - block.opener.length - marker.length - 2;

  if (budget < MIN_CODE_BUDGET) {
    return splitBlock(
      { kind: "text", lines: renderBlock(block).split("\n") },
      maxLength
    );
  }

  const groups = packLines(block.lines, budget);

  return groups.map((group, position) => {
    const isLast = position === groups.length - 1;
    const closer = isLast ? block.closer : marker;

    return renderBlock({
      closer,
      kind: "code",
      lines: group,
      opener: block.opener,
    });
  });
};

/**
 * Splits Markdown into chunks of at most `maxLength` UTF-16 code units for platform message limits.
 *
 * Breaks between paragraphs first, then between lines, then at spaces. A fenced code block that does not fit is
 * closed at the end of one chunk and reopened with the same info string at the start of the next. Returns `[text]` if
 * the text fits. Throws a `RangeError` if `maxLength` is not an integer of at least `MIN_CHUNK_LENGTH`.
 */
export const chunkMarkdown = (text: string, maxLength: number): string[] => {
  if (!Number.isInteger(maxLength) || maxLength < MIN_CHUNK_LENGTH) {
    throw new RangeError(
      `maxLength must be an integer of at least ${MIN_CHUNK_LENGTH}`
    );
  }

  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let current = "";

  for (const block of parseBlocks(text)) {
    const rendered = renderBlock(block);
    const joined = current === "" ? rendered : `${current}\n\n${rendered}`;

    if (joined.length <= maxLength) {
      current = joined;
    } else {
      if (current !== "") {
        chunks.push(current);
      }

      const pieces =
        rendered.length <= maxLength
          ? [rendered]
          : splitBlock(block, maxLength);

      chunks.push(...pieces.slice(0, -1));
      current = pieces.at(-1) ?? "";
    }
  }

  if (current !== "") {
    chunks.push(current);
  }

  return chunks;
};
