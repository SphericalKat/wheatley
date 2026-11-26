import { Box, Text, useInput, usePaste } from "ink";
import type { Key } from "ink";
import { useRef, useState } from "react";

import { commandLabel, matchCommands } from "./commands.js";
import type { ChatCommand } from "./commands.js";
import {
  deleteBackward,
  deleteForward,
  deleteToLineEnd,
  deleteToLineStart,
  deleteWordBackward,
  draftOf,
  EMPTY_DRAFT,
  HISTORY_START,
  insert,
  moveEnd,
  moveHome,
  moveLeft,
  moveRight,
  moveVertical,
  moveWordLeft,
  moveWordRight,
  onFirstLine,
  onLastLine,
  stepHistory,
} from "./editor.js";
import type { Draft, HistoryCursor } from "./editor.js";

const MENU_ROWS = 10;

/** A second Ctrl+C or Esc within this time exits or clears the line. */
const DOUBLE_PRESS_MS = 2000;

/** A paste with more lines or characters than this shows as one placeholder in the input box. */
const PASTE_LINES = 8;
const PASTE_CHARACTERS = 2000;
const HISTORY_LIMIT = 500;
const PASTE_TOKEN = /\[Pasted text #(?<number>\d+) · \d+ lines\]/gu;
const FIRST_PRINTABLE = 0x20;
const DELETE_CHARACTER = 0x7f;

/** Removes control characters from typed input, for example the bytes of an unknown escape sequence. */
const printable = (text: string): string => {
  let result = "";

  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;

    if (code >= FIRST_PRINTABLE && code !== DELETE_CHARACTER) {
      result += character;
    }
  }

  return result;
};

export interface PromptProps {
  readonly busy: boolean;
  readonly columns: number;
  readonly history: readonly string[];
  readonly onHistory: (history: readonly string[]) => void;
  /** Receives the submitted text, with pasted blocks expanded. */
  readonly onSubmit: (text: string) => void;
  /** Stops the active Run or shell command. Returns false if nothing was running. */
  readonly onInterrupt: () => boolean;
  readonly onExit: () => void;
}

interface MenuProps {
  readonly matches: readonly ChatCommand[];
  readonly selected: number;
}

const Menu = ({ matches, selected }: MenuProps) => {
  const width = Math.max(
    ...matches.map((command) => commandLabel(command).length)
  );

  return (
    <Box flexDirection="column" marginLeft={2}>
      {matches.map((command, index) => {
        const isSelected = index === selected;

        return (
          <Text key={command.word}>
            <Text color="cyan">{isSelected ? "› " : "  "}</Text>
            <Text bold={isSelected} color={isSelected ? "cyan" : undefined}>
              {commandLabel(command).padEnd(width)}
            </Text>
            <Text dimColor> {command.description}</Text>
            {command.local ? <Text dimColor> · local</Text> : undefined}
          </Text>
        );
      })}
    </Box>
  );
};

interface InputLinesProps {
  readonly draft: Draft;
  readonly ghost: string;
  readonly busy: boolean;
}

/** The draft with a block cursor. The ghost text shows the rest of the selected command after the cursor. */
const InputLines = ({ draft, ghost, busy }: InputLinesProps) => {
  if (draft.text === "") {
    return (
      <Text>
        <Text inverse> </Text>
        <Text dimColor>
          {busy
            ? " Type the next message, or press Esc to interrupt"
            : " Ask anything · / for commands · ! for shell"}
        </Text>
      </Text>
    );
  }

  const before = draft.text.slice(0, draft.cursor);
  const atCursor = draft.text[draft.cursor];
  const after = draft.text.slice(draft.cursor + 1);

  // A newline under the cursor shows as a space, so the cursor stays visible at a line end.
  const cursorCharacter =
    atCursor === undefined || atCursor === "\n" ? " " : atCursor;

  const restAfterCursor = atCursor === "\n" ? `\n${after}` : after;

  return (
    <Text>
      {before}
      <Text inverse>{cursorCharacter}</Text>
      {restAfterCursor}
      {ghost === "" ? undefined : <Text dimColor>{ghost}</Text>}
    </Text>
  );
};

type KeyHandler = (input: string, key: Key) => boolean;

/** The input box with the command menu and the key bindings. */
export const Prompt = ({
  busy,
  columns,
  history,
  onHistory,
  onSubmit,
  onInterrupt,
  onExit,
}: PromptProps) => {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [selected, setSelected] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [hint, setHint] = useState<string | undefined>();
  const historyRef = useRef<string[]>([...history]);
  const historyCursor = useRef<HistoryCursor>(HISTORY_START);
  const pastes = useRef(new Map<number, string>());
  const lastCtrlC = useRef(0);
  const lastEscape = useRef(0);

  const matches = menuDismissed
    ? []
    : matchCommands(draft.text).slice(0, MENU_ROWS);

  const choice = matches[Math.min(selected, matches.length - 1)];

  const ghost =
    choice !== undefined &&
    choice.word.startsWith(draft.text) &&
    draft.cursor === draft.text.length
      ? choice.word.slice(draft.text.length)
      : "";

  const edit = (next: Draft): void => {
    setDraft(next);
    setSelected(0);
    setMenuDismissed(false);
    setHint(undefined);
    historyCursor.current = HISTORY_START;
  };

  const submit = (text: string): void => {
    let expanded = text;

    for (const match of text.matchAll(PASTE_TOKEN)) {
      const pasted = pastes.current.get(Number(match.groups?.number));

      if (pasted !== undefined) {
        expanded = expanded.replace(match[0], pasted);
      }
    }

    if (expanded.trim() !== "") {
      const next = [
        expanded,
        ...historyRef.current.filter((entry) => entry !== expanded),
      ].slice(0, HISTORY_LIMIT);

      historyRef.current = next;
      onHistory(next);
    }

    pastes.current.clear();
    edit(EMPTY_DRAFT);
    onSubmit(expanded);
  };

  const onReturn = (key: Key): void => {
    if (key.meta || key.shift) {
      edit(insert(draft, "\n"));

      return;
    }

    if (draft.text.endsWith("\\") && draft.cursor === draft.text.length) {
      edit(insert(deleteBackward(draft), "\n"));

      return;
    }

    submit(choice === undefined ? draft.text : choice.word);
  };

  const onCtrlC = (): void => {
    if (draft.text !== "") {
      edit(EMPTY_DRAFT);

      return;
    }

    if (onInterrupt()) {
      return;
    }

    const now = Date.now();

    if (now - lastCtrlC.current < DOUBLE_PRESS_MS) {
      onExit();

      return;
    }

    lastCtrlC.current = now;
    setHint("Press Ctrl+C again to exit");
  };

  const onEscape = (): void => {
    if (matches.length > 0) {
      setMenuDismissed(true);

      return;
    }

    if (onInterrupt()) {
      return;
    }

    const now = Date.now();

    if (draft.text !== "" && now - lastEscape.current < DOUBLE_PRESS_MS) {
      edit(EMPTY_DRAFT);

      return;
    }

    lastEscape.current = now;

    if (draft.text !== "") {
      setHint("Press Esc again to clear the line");
    }
  };

  const onVertical = (step: -1 | 1): void => {
    if (matches.length > 0) {
      setSelected((selected + step + matches.length) % matches.length);

      return;
    }

    const atEdge = step === -1 ? onFirstLine(draft) : onLastLine(draft);

    if (!atEdge) {
      setDraft(moveVertical(draft, step));

      return;
    }

    // Up goes to older entries, which have higher indexes.
    const moved = stepHistory(
      historyRef.current,
      historyCursor.current,
      draft,
      step === -1 ? 1 : -1
    );

    if (moved !== undefined) {
      historyCursor.current = moved.cursor;
      setDraft(moved.draft);
    }
  };

  /** Ctrl plus a letter. Returns false for a letter without a binding. */
  const ctrlLetter = (letter: string): boolean => {
    switch (letter) {
      case "a": {
        setDraft(moveHome(draft));
        break;
      }

      case "c": {
        onCtrlC();
        break;
      }

      case "d": {
        if (draft.text === "") {
          onExit();
        } else {
          edit(deleteForward(draft));
        }

        break;
      }

      case "e": {
        setDraft(moveEnd(draft));
        break;
      }

      case "j": {
        edit(insert(draft, "\n"));
        break;
      }

      case "k": {
        edit(deleteToLineEnd(draft));
        break;
      }

      case "u": {
        edit(deleteToLineStart(draft));
        break;
      }

      case "w": {
        edit(deleteWordBackward(draft));
        break;
      }

      default: {
        return false;
      }
    }

    return true;
  };

  const ctrlKeys: KeyHandler = (input, key) => {
    if (!key.ctrl) {
      return false;
    }

    if (key.leftArrow || key.rightArrow) {
      setDraft(key.leftArrow ? moveWordLeft(draft) : moveWordRight(draft));

      return true;
    }

    return ctrlLetter(input);
  };

  const navigationKeys: KeyHandler = (_input, key) => {
    if (key.upArrow || key.downArrow) {
      onVertical(key.upArrow ? -1 : 1);
    } else if (key.leftArrow) {
      setDraft(key.meta ? moveWordLeft(draft) : moveLeft(draft));
    } else if (key.rightArrow) {
      // Right at the end of the line takes the ghost text, as in a shell.
      if (ghost !== "" && draft.cursor === draft.text.length) {
        setDraft(draftOf(`${draft.text}${ghost}`));
      } else {
        setDraft(key.meta ? moveWordRight(draft) : moveRight(draft));
      }
    } else if (key.home || key.end) {
      setDraft(key.home ? moveHome(draft) : moveEnd(draft));
    } else {
      return false;
    }

    return true;
  };

  useInput((input, key) => {
    if (ctrlKeys(input, key) || navigationKeys(input, key)) {
      return;
    }

    if (key.return) {
      onReturn(key);
    } else if (key.escape) {
      onEscape();
    } else if (key.tab) {
      if (choice !== undefined) {
        edit(
          draftOf(
            choice.argument === undefined ? choice.word : `${choice.word} `
          )
        );
      }
    } else if (key.backspace || key.delete) {
      edit(key.meta ? deleteWordBackward(draft) : deleteBackward(draft));
    } else if (input !== "") {
      const text = printable(input);

      if (text !== "") {
        edit(insert(draft, text));
      }
    }
  });

  usePaste((pasted) => {
    const text = pasted.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    const lines = text.split("\n").length;

    if (lines <= PASTE_LINES && text.length <= PASTE_CHARACTERS) {
      edit(insert(draft, text));

      return;
    }

    const number = pastes.current.size + 1;

    pastes.current.set(number, text);
    edit(insert(draft, `[Pasted text #${number} · ${lines} lines]`));
  });

  return (
    <Box flexDirection="column">
      <Box
        borderColor={busy ? "gray" : "cyan"}
        borderStyle="round"
        paddingX={1}
        width={columns}
      >
        <Box width={2}>
          <Text bold color="cyan">
            ›
          </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <InputLines busy={busy} draft={draft} ghost={ghost} />
        </Box>
      </Box>
      {matches.length > 0 ? (
        <Menu
          matches={matches}
          selected={Math.min(selected, matches.length - 1)}
        />
      ) : undefined}
      {hint === undefined ? undefined : (
        <Box marginLeft={2}>
          <Text color="yellow">{hint}</Text>
        </Box>
      )}
    </Box>
  );
};
