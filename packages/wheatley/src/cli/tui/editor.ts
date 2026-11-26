/** The text of the input box and the cursor position in it. The text can hold newlines. */
export interface Draft {
  readonly text: string;
  /** An index into `text`, from 0 to `text.length`. */
  readonly cursor: number;
}

export const EMPTY_DRAFT: Draft = { cursor: 0, text: "" };

export const draftOf = (text: string): Draft => ({ cursor: text.length, text });

export const insert = (draft: Draft, value: string): Draft => ({
  cursor: draft.cursor + value.length,
  text: `${draft.text.slice(0, draft.cursor)}${value}${draft.text.slice(draft.cursor)}`,
});

export const deleteBackward = (draft: Draft): Draft =>
  draft.cursor === 0
    ? draft
    : {
        cursor: draft.cursor - 1,
        text: `${draft.text.slice(0, draft.cursor - 1)}${draft.text.slice(draft.cursor)}`,
      };

export const deleteForward = (draft: Draft): Draft => ({
  cursor: draft.cursor,
  text: `${draft.text.slice(0, draft.cursor)}${draft.text.slice(draft.cursor + 1)}`,
});

export const moveLeft = (draft: Draft): Draft => ({
  ...draft,
  cursor: Math.max(0, draft.cursor - 1),
});

export const moveRight = (draft: Draft): Draft => ({
  ...draft,
  cursor: Math.min(draft.text.length, draft.cursor + 1),
});

const lineStart = (draft: Draft): number =>
  draft.text.lastIndexOf("\n", draft.cursor - 1) + 1;

const lineEnd = (draft: Draft): number => {
  const end = draft.text.indexOf("\n", draft.cursor);

  return end === -1 ? draft.text.length : end;
};

export const moveHome = (draft: Draft): Draft => ({
  ...draft,
  cursor: lineStart(draft),
});

export const moveEnd = (draft: Draft): Draft => ({
  ...draft,
  cursor: lineEnd(draft),
});

const WORD_CHARACTER = /\w/u;

const isWordCharacter = (character: string | undefined): boolean =>
  character !== undefined && WORD_CHARACTER.test(character);

/** The index of the start of the word before the cursor. Skips spaces and punctuation before the word first. */
const previousWordStart = (draft: Draft): number => {
  let index = draft.cursor;

  while (index > 0 && !isWordCharacter(draft.text[index - 1])) {
    index -= 1;
  }

  while (index > 0 && isWordCharacter(draft.text[index - 1])) {
    index -= 1;
  }

  return index;
};

const nextWordEnd = (draft: Draft): number => {
  let index = draft.cursor;

  while (index < draft.text.length && !isWordCharacter(draft.text[index])) {
    index += 1;
  }

  while (index < draft.text.length && isWordCharacter(draft.text[index])) {
    index += 1;
  }

  return index;
};

export const moveWordLeft = (draft: Draft): Draft => ({
  ...draft,
  cursor: previousWordStart(draft),
});

export const moveWordRight = (draft: Draft): Draft => ({
  ...draft,
  cursor: nextWordEnd(draft),
});

/** Ctrl+W: deletes the word before the cursor. */
export const deleteWordBackward = (draft: Draft): Draft => {
  const start = previousWordStart(draft);

  return {
    cursor: start,
    text: `${draft.text.slice(0, start)}${draft.text.slice(draft.cursor)}`,
  };
};

/** Ctrl+U: deletes from the start of the current line to the cursor. */
export const deleteToLineStart = (draft: Draft): Draft => {
  const start = lineStart(draft);

  return {
    cursor: start,
    text: `${draft.text.slice(0, start)}${draft.text.slice(draft.cursor)}`,
  };
};

/** Ctrl+K: deletes from the cursor to the end of the current line. */
export const deleteToLineEnd = (draft: Draft): Draft => ({
  cursor: draft.cursor,
  text: `${draft.text.slice(0, draft.cursor)}${draft.text.slice(lineEnd(draft))}`,
});

/** True if the cursor is on the first line of the draft. Up then recalls history instead of moving between lines. */
export const onFirstLine = (draft: Draft): boolean =>
  !draft.text.slice(0, draft.cursor).includes("\n");

/** True if the cursor is on the last line of the draft. */
export const onLastLine = (draft: Draft): boolean =>
  !draft.text.slice(draft.cursor).includes("\n");

/** Moves the cursor one line up or down, and keeps its column where the line is long enough. */
export const moveVertical = (draft: Draft, step: -1 | 1): Draft => {
  const start = lineStart(draft);
  const column = draft.cursor - start;

  if (step === -1) {
    const previousEnd = start - 1;
    const previousStart = draft.text.lastIndexOf("\n", previousEnd - 1) + 1;

    return {
      ...draft,
      cursor: Math.min(previousStart + column, previousEnd),
    };
  }

  const end = lineEnd(draft);
  const nextStart = end + 1;
  const nextEnd = lineEnd({ ...draft, cursor: nextStart });

  return { ...draft, cursor: Math.min(nextStart + column, nextEnd) };
};

/**
 * Input history, newest first, with a draft slot. Moving into history saves the unsent draft. Moving back past the
 * newest entry restores it.
 */
export interface HistoryCursor {
  /** -1 while the user edits the draft, or the index of the shown history entry. */
  readonly index: number;
  readonly saved: Draft;
}

export const HISTORY_START: HistoryCursor = { index: -1, saved: EMPTY_DRAFT };

/** Moves one step back (older) or forward (newer) in `history`. Returns `undefined` at either end. */
export const stepHistory = (
  history: readonly string[],
  cursor: HistoryCursor,
  current: Draft,
  step: -1 | 1
): { readonly cursor: HistoryCursor; readonly draft: Draft } | undefined => {
  // Step 1 is older. The newest entry is at index 0.
  const index = cursor.index + step;

  if (index < -1 || index >= history.length) {
    return undefined;
  }

  const saved = cursor.index === -1 ? current : cursor.saved;
  const entry = history[index];

  return {
    cursor: { index, saved },
    draft: index === -1 || entry === undefined ? saved : draftOf(entry),
  };
};
