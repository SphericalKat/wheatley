import { styleText } from "node:util";

/**
 * What the spinner says while the Agent thinks. These lines are original. They imitate the voice of an eager,
 * slightly overconfident robot, not any script.
 */
export const THINKING_LINES = [
  "Right. Right, right, right. Thinking.",
  "Having a proper think. With the whole brain.",
  "Bit of a tricky one, this. Love a tricky one.",
  "It's in here somewhere. Rummaging.",
  "Nearly there. Probably. Define 'nearly'.",
  "Not stalling. This is thinking. Looks similar.",
  "Plugging in a few ideas. Unplugging the bad ones.",
  "Got a plan. Most of a plan. The start of a plan.",
  "Crunching the numbers. Some of them are words.",
  "Doing the clever bit now. Don't look.",
  "Rerouting a few thoughts. Mind the sparks.",
  "Completely under control. Largely under control.",
  "Brilliant idea incoming. Brace yourself.",
  "Checking my work. Twice. Once more for luck.",
  "Ooh. Interesting. Give me a second.",
  "Very nearly a genius move. Stand by.",
  "Thinking quietly. Well, quietly for me.",
  "Just tightening a few bolts on this answer.",
] as const;

/** The spinner lines for one Run: every thinking line once, in a random order. */
export const shuffledThinkingLines = (): string[] => {
  const lines: string[] = [...THINKING_LINES];

  for (let index = lines.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    const current = lines[index];
    const swapped = lines[other];

    if (current !== undefined && swapped !== undefined) {
      lines[index] = swapped;
      lines[other] = current;
    }
  }

  return lines;
};

/** "WHEATLEY" in block letters. Every row has the same width. */
const BANNER_ROWS = [
  "█   █ █   █ █████  ███  █████ █     █████ █   █",
  "█   █ █   █ █     █   █   █   █     █      █ █ ",
  "█ █ █ █████ ████  █████   █   █     ████    █  ",
  "██ ██ █   █ █     █   █   █   █     █       █  ",
  "█   █ █   █ █████ █   █   █   █████ █████   █  ",
] as const;

const BANNER_COLORS = [
  "cyanBright",
  "cyanBright",
  "cyan",
  "cyan",
  "blue",
] as const;

const BANNER_WIDTH = BANNER_ROWS[0].length;

/** The space that the banner keeps on each side. */
const BANNER_MARGIN = 4;

/** "WHEATLEY" in colored block letters, or one line on a terminal too narrow for them. */
export const bannerArt = (columns: number): string =>
  columns < BANNER_WIDTH + BANNER_MARGIN
    ? styleText(["cyan", "bold"], "◉ wheatley")
    : BANNER_ROWS.map((row, index) =>
        styleText(BANNER_COLORS[index] ?? "cyan", row)
      ).join("\n");

/** Tips for the welcome screen. */
export const TIPS = [
  "Type / to open the command menu, then Tab to complete.",
  "Start a line with ! to run a shell command here, for example !git status.",
  "End a line with \\ and press Enter to add a new line. Pasted text keeps its lines.",
  "Press Esc to interrupt a Run. You can type the next message while it works.",
  "/copy puts the last reply on your clipboard, even over SSH.",
  "Ctrl+W deletes a word, Ctrl+U the line before the cursor, and Ctrl+K the rest.",
  "The dashboard shows this same Chat at http://127.0.0.1:7420/.",
  "Up and Down recall what you typed earlier, across sessions.",
] as const;

/** Lines for the end of a chat. Original, in the same eager voice as the thinking lines. */
export const GOODBYES = [
  "Right. Off you go, then. I'll just be here. Thinking.",
  "Lovely chat. Really top quality. Same time tomorrow?",
  "Bye! Don't touch anything on the way out.",
  "Going quiet now. Very quiet. Starting… now.",
] as const;

/** A random element of `items`. */
export const pick = <T>(items: readonly T[]): T | undefined =>
  items[Math.floor(Math.random() * items.length)];
