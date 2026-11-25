import {
  clearScreenDown,
  createInterface,
  cursorTo,
  moveCursor,
} from "node:readline";

/** The frames of the spinning logo. */
const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"] as const;
const SPINNER_FRAME_MS = 120;
const MS_PER_SECOND = 1000;
const HISTORY_SIZE = 500;

/** Settings of the interactive terminal. */
export interface TerminalOptions {
  /** The words that Tab completes at the start of a line, for example `/new`. */
  readonly completions: readonly string[];
  /** Earlier input lines, newest first. */
  readonly history: readonly string[];
  /** Receives the input history, newest first, after each new line. */
  readonly onHistory: (history: readonly string[]) => void;
}

/**
 * An interactive terminal: a prompt line with an optional spinner line above it. Output goes above both, so the user
 * can type while a Run works.
 */
export interface TerminalUi {
  /** The input lines. Ends at Ctrl+D, or at Ctrl+C on an empty line when `onInterrupt` does not handle it. */
  readonly lines: AsyncIterator<string>;
  /** Writes `text` above the spinner and the prompt, and keeps the typed input. */
  readonly print: (text: string) => void;
  readonly setPrompt: (prompt: string) => void;
  /** Shows the spinner with `label`. A running spinner keeps its start time and takes the new label. */
  readonly spin: (label: string) => void;
  readonly stopSpin: () => void;
  /** Handles Ctrl+C. Return true if it did something, for example stopped a Run. */
  onInterrupt: (() => boolean) | undefined;
  /** Removes the spinner and the prompt and restores the terminal. */
  readonly close: () => void;
}

const complete = (
  completions: readonly string[],
  line: string
): [string[], string] => {
  const isCommandStart = line.startsWith("/") && !line.includes(" ");

  return [
    isCommandStart ? completions.filter((word) => word.startsWith(line)) : [],
    line,
  ];
};

/** Opens the interactive terminal on `input` and `output`, which must both be terminals. */
export const openTerminal = (
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  options: TerminalOptions
): TerminalUi => {
  const readline = createInterface({
    completer: (line: string) => complete(options.completions, line),
    history: [...options.history],
    historySize: HISTORY_SIZE,
    input,
    output,
    removeHistoryDuplicates: true,
    terminal: true,
  });

  let prompt = "";
  let closed = false;
  let spinner: { label: string; startedAt: number } | undefined;
  let timer: NodeJS.Timeout | undefined;
  let frame = 0;
  // The rows above the prompt line that the spinner uses.
  let spinnerRows = 0;

  const clear = (): void => {
    cursorTo(output, 0);
    moveCursor(output, 0, -spinnerRows);
    clearScreenDown(output);
    spinnerRows = 0;
  };

  const draw = (): void => {
    if (spinner !== undefined) {
      const seconds = Math.floor(
        (Date.now() - spinner.startedAt) / MS_PER_SECOND
      );

      const logo = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "";

      output.write(`${logo} ${spinner.label} ${seconds}s\n`);
      spinnerRows = 1;
    }

    if (!closed) {
      readline.setPrompt(prompt);
      readline.prompt(true);
    }
  };

  const redraw = (): void => {
    clear();
    draw();
  };

  readline.on("history", (history: string[]) => {
    options.onHistory(history);
  });

  // Readline has already moved below the submitted line. Move it below the spinner, so the spinner does not stay
  // behind in the scrollback.
  readline.on("line", (line: string) => {
    if (spinnerRows > 0) {
      moveCursor(output, 0, -(spinnerRows + 1));
      cursorTo(output, 0);
      clearScreenDown(output);
      output.write(`${prompt}${line}\n`);
      spinnerRows = 0;
    }

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
    spin: (label) => {
      if (spinner === undefined) {
        spinner = { label, startedAt: Date.now() };
        timer = setInterval(() => {
          frame += 1;
          redraw();
        }, SPINNER_FRAME_MS);
      } else {
        spinner.label = label;
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
    readline.write("", { ctrl: true, name: "e" });
    readline.write("", { ctrl: true, name: "u" });
  });

  draw();

  return ui;
};
