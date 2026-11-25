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

/** The banner that `wheatley chat` prints on start. A terminal too narrow for the block letters gets one line. */
export const banner = (
  columns: number,
  version: string,
  agent: string
): string => {
  const details = styleText(
    "dim",
    `  v${version} · chatting with ${agent} · /help for commands`
  );

  if (columns < BANNER_WIDTH + BANNER_MARGIN) {
    return `${styleText(["cyan", "bold"], "◉ wheatley")}\n${details}\n`;
  }

  const art = BANNER_ROWS.map(
    (row, index) => `  ${styleText(BANNER_COLORS[index] ?? "cyan", row)}`
  );

  return `\n${art.join("\n")}\n\n${details}\n`;
};
