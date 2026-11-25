import {
  clearScreenDown,
  createInterface,
  cursorTo,
  moveCursor,
} from "node:readline";
import type { Key } from "node:readline";
import { styleText } from "node:util";

/** The frames of the spinning logo. */
const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"] as const;
const SPINNER_FRAME_MS = 120;

/** How long the spinner shows one label before it moves to the next. */
const LABEL_MS = 3500;
const MS_PER_SECOND = 1000;
const HISTORY_SIZE = 500;
const MENU_ROWS = 10;
const FALLBACK_COLUMNS = 80;

/** One command that the menu under the prompt offers. */
export interface Completion {
  /** The full command, for example `/model`. */
  readonly word: string;
  /** A hint for the argument, for example `<model-id>`. */
  readonly argument?: string;
  readonly description: string;
}

/** Settings of the interactive terminal. */
export interface TerminalOptions {
  /** The commands that the menu offers when a line starts with `/`. */
  readonly completions: readonly Completion[];
  /** Earlier input lines, newest first. */
  readonly history: readonly string[];
  /** Receives the input history, newest first, after each new line. */
  readonly onHistory: (history: readonly string[]) => void;
}

/**
 * An interactive terminal: a spinner line, a prompt line, and a command menu under the prompt. Output goes above all
 * three, so the user can type while a Run works.
 */
export interface TerminalUi {
  /** The input lines. Ends at Ctrl+D, or at Ctrl+C on an empty line when `onInterrupt` does not handle it. */
  readonly lines: AsyncIterator<string>;
  /** The width of the terminal in columns. */
  readonly columns: number;
  /** Writes `text` above the spinner and the prompt, and keeps the typed input. */
  readonly print: (text: string) => void;
  readonly setPrompt: (prompt: string) => void;
  /**
   * Shows the spinner. It shows each label for a few seconds, in order, and starts again after the last one. A
   * running spinner keeps its start time and takes the new labels.
   */
  readonly spin: (labels: readonly string[]) => void;
  readonly stopSpin: () => void;
  /** Handles Ctrl+C. Return true if it did something, for example stopped a Run. */
  onInterrupt: (() => boolean) | undefined;
  /** Removes the spinner and the prompt and restores the terminal. */
  readonly close: () => void;
}

/** The commands that start with `line`, while the line is a command name without arguments. */
const matchCommands = (
  completions: readonly Completion[],
  line: string
): readonly Completion[] => {
  const isCommandName = line.startsWith("/") && !line.includes(" ");

  return isCommandName
    ? completions.filter((completion) => completion.word.startsWith(line))
    : [];
};

const commandName = (completion: Completion): string =>
  completion.argument === undefined
    ? completion.word
    : `${completion.word} ${completion.argument}`;

const menuRow = (
  completion: Completion,
  selected: boolean,
  width: number
): string => {
  const name = commandName(completion).padEnd(width);
  const marker = selected ? styleText("cyan", "›") : " ";
  const styledName = selected ? styleText(["cyan", "bold"], name) : name;

  return `  ${marker} ${styledName}  ${styleText("dim", completion.description)}`;
};

interface Spinner {
  labels: readonly string[];
  readonly startedAt: number;
}

declare module "node:readline" {
  interface Interface {
    /** Handles one key. Node does not document this method, but every `readline` since Node.js 0.x has it. */
    _ttyWrite: (data: string | undefined, key: Key | undefined) => void;
  }
}

/** Opens the interactive terminal on `input` and `output`, which must both be terminals. */
export const openTerminal = (
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  options: TerminalOptions
): TerminalUi => {
  const readline = createInterface({
    history: [...options.history],
    historySize: HISTORY_SIZE,
    input,
    output,
    removeHistoryDuplicates: true,
    terminal: true,
  });

  let prompt = "";
  let closed = false;
  let spinner: Spinner | undefined;
  let timer: NodeJS.Timeout | undefined;
  let frame = 0;
  // The rows above the prompt line that the spinner uses.
  let spinnerRows = 0;
  let selected = 0;

  const menu = (): readonly Completion[] =>
    closed
      ? []
      : matchCommands(options.completions, readline.line).slice(0, MENU_ROWS);

  const clear = (): void => {
    cursorTo(output, 0);
    moveCursor(output, 0, -spinnerRows);
    clearScreenDown(output);
    spinnerRows = 0;
  };

  const drawSpinner = (current: Spinner): void => {
    const elapsed = Date.now() - current.startedAt;
    const labelIndex = Math.floor(elapsed / LABEL_MS) % current.labels.length;
    const label = current.labels[labelIndex] ?? "";
    const logo = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "";
    const seconds = Math.floor(elapsed / MS_PER_SECOND);

    output.write(
      `${styleText("cyan", logo)} ${label} ${styleText("dim", `${seconds}s · ctrl+c to stop`)}\n`
    );
    spinnerRows = 1;
  };

  // Draws the menu under the prompt, then puts the cursor back where readline expects it.
  const drawMenu = (): void => {
    const matches = menu();

    if (matches.length === 0) {
      return;
    }

    selected = Math.min(selected, matches.length - 1);

    const width = Math.max(
      ...matches.map((completion) => commandName(completion).length)
    );

    const rows = matches.map((completion, index) =>
      menuRow(completion, index === selected, width)
    );

    output.write(`\n${rows.join("\n")}`);
    moveCursor(output, 0, -rows.length);
    cursorTo(output, readline.getCursorPos().cols);
  };

  const draw = (): void => {
    if (spinner !== undefined) {
      drawSpinner(spinner);
    }

    if (!closed) {
      readline.setPrompt(prompt);
      readline.prompt(true);
      drawMenu();
    }
  };

  const redraw = (): void => {
    clear();
    draw();
  };

  const ttyWrite = readline._ttyWrite.bind(readline);

  /** Replaces the typed line with `text`. */
  const replaceLine = (text: string): void => {
    ttyWrite(undefined, { ctrl: true, name: "e" });
    ttyWrite(undefined, { ctrl: true, name: "u" });

    for (const character of text) {
      ttyWrite(character, { name: character });
    }
  };

  /** Handles one key. With the menu open, Up and Down select a command, Tab takes it, and Enter runs it. */
  const onKey = (data: string | undefined, key: Key | undefined): void => {
    const matches = menu();
    const choice = matches[selected];
    const name = key?.name;

    if (choice !== undefined && (name === "up" || name === "down")) {
      const step = name === "up" ? -1 : 1;

      selected = (selected + step + matches.length) % matches.length;
      redraw();

      return;
    }

    if (name === "tab") {
      if (choice !== undefined) {
        replaceLine(
          choice.argument === undefined ? choice.word : `${choice.word} `
        );
      }

      selected = 0;
      redraw();

      return;
    }

    if (choice !== undefined && name === "return") {
      replaceLine(choice.word);
    }

    const before = readline.line;

    ttyWrite(data, key);

    if (readline.line !== before) {
      selected = 0;
    }

    if (!closed && name !== "return" && name !== "enter") {
      redraw();
    }
  };

  readline._ttyWrite = onKey;

  readline.on("history", (history: string[]) => {
    options.onHistory(history);
  });

  // Readline has already moved below the submitted line. Clear from the spinner down and write the line again, so the
  // spinner and the menu rows do not stay behind in the scrollback.
  readline.on("line", (line: string) => {
    moveCursor(output, 0, -(spinnerRows + 1));
    cursorTo(output, 0);
    clearScreenDown(output);
    output.write(`${prompt}${line}\n`);
    spinnerRows = 0;
    selected = 0;
    draw();
  });

  readline.on("close", () => {
    closed = true;
  });

  const ui: TerminalUi = {
    close: () => {
      clearInterval(timer);
      spinner = undefined;
      clear();
      closed = true;
      readline.close();
    },
    get columns() {
      return output.columns ?? FALLBACK_COLUMNS;
    },
    lines: readline[Symbol.asyncIterator](),
    onInterrupt: undefined,
    print: (text) => {
      clear();
      output.write(text.endsWith("\n") ? text : `${text}\n`);
      draw();
    },
    setPrompt: (next) => {
      if (next !== prompt) {
        prompt = next;
        redraw();
      }
    },
    spin: (labels) => {
      if (spinner === undefined) {
        spinner = { labels, startedAt: Date.now() };
        timer = setInterval(() => {
          frame += 1;
          redraw();
        }, SPINNER_FRAME_MS);
      } else {
        spinner.labels = labels;
      }

      redraw();
    },
    stopSpin: () => {
      if (spinner !== undefined) {
        clearInterval(timer);
        spinner = undefined;
        redraw();
      }
    },
  };

  readline.on("SIGINT", () => {
    if (ui.onInterrupt?.() === true) {
      return;
    }

    if (readline.line === "") {
      readline.close();

      return;
    }

    // Ctrl+C on typed text clears the line, as in a shell.
    replaceLine("");
    redraw();
  });

  draw();

  return ui;
};
