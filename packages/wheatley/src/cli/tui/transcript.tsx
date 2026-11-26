import { Box, Text } from "ink";

import { bannerArt, pick, TIPS } from "../personality.js";
import { CHAT_COMMANDS, commandLabel } from "./commands.js";
import type { ChatView, Entry } from "./controller.js";
import { formatCount, formatCost, formatSeconds } from "./format.js";
import { wrapLines } from "./markdown.js";

const OUTPUT_PREVIEW_LINES = 3;

/** The column of the reply logo. Reply text starts after it. */
export const LOGO_WIDTH = 2;

interface BannerProps {
  readonly view: ChatView;
  readonly version: string;
  readonly columns: number;
}

const Banner = ({ view, version, columns }: BannerProps) => (
  <Box flexDirection="column" marginBottom={1}>
    <Box marginLeft={2} marginTop={1}>
      <Text>{bannerArt(columns)}</Text>
    </Box>
    <Box
      borderColor="cyan"
      borderStyle="round"
      flexDirection="column"
      marginTop={1}
      paddingX={1}
    >
      <Text>
        <Text bold color="cyan">
          wheatley
        </Text>
        <Text dimColor> v{version}</Text>
        <Text> · agent </Text>
        <Text bold>{view.agent}</Text>
        {view.model === undefined ? undefined : (
          <>
            <Text> · </Text>
            <Text color="magenta">{view.model}</Text>
          </>
        )}
      </Text>
      {view.extensions === undefined ? undefined : (
        <Text dimColor>{view.extensions}</Text>
      )}
      <Text dimColor>{process.cwd()}</Text>
      <Text>
        <Text color="yellow">Tip </Text>
        <Text dimColor>{pick(TIPS)}</Text>
      </Text>
    </Box>
  </Box>
);

const KEYS = [
  ["Enter", "Send. With the menu open, run the selected command."],
  ["\\ then Enter, Alt+Enter", "Add a new line."],
  ["Tab", "Complete the selected command."],
  ["Up, Down", "Move in the menu, or recall earlier input."],
  ["!command", "Run a shell command here. Nothing goes to the Agent."],
  ["Esc", "Close the menu, interrupt the Run, or clear the line (twice)."],
  ["Ctrl+C", "Clear the line, stop the Run, or exit (twice)."],
  [
    "Ctrl+W, Ctrl+U, Ctrl+K",
    "Delete a word, to the line start, or to the line end.",
  ],
  ["Ctrl+D", "Exit on an empty line."],
] as const;

const Help = () => {
  const commandWidth = Math.max(
    ...CHAT_COMMANDS.map((command) => commandLabel(command).length)
  );

  const keyWidth = Math.max(...KEYS.map(([key]) => key.length));

  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text bold>Commands</Text>
      {CHAT_COMMANDS.map((command) => (
        <Text key={command.word}>
          <Text color="cyan">{commandLabel(command).padEnd(commandWidth)}</Text>
          <Text dimColor> {command.description}</Text>
        </Text>
      ))}
      <Text> </Text>
      <Text bold>Keys</Text>
      {KEYS.map(([key, action]) => (
        <Text key={key}>
          <Text color="cyan">{key.padEnd(keyWidth)}</Text>
          <Text dimColor> {action}</Text>
        </Text>
      ))}
    </Box>
  );
};

const previewLines = (text: string): string => {
  const lines = text.split("\n");

  return lines.length > OUTPUT_PREVIEW_LINES
    ? [
        ...lines.slice(0, OUTPUT_PREVIEW_LINES),
        `… ${lines.length - OUTPUT_PREVIEW_LINES} more lines`,
      ].join("\n")
    : text;
};

const TurnLine = ({
  entry,
}: {
  readonly entry: Extract<Entry, { kind: "turn" }>;
}) => {
  const parts = [
    formatSeconds(entry.seconds),
    entry.tools === 1 ? "1 tool" : `${entry.tools} tools`,
  ];

  if (entry.usage !== undefined) {
    parts.push(
      `↑${formatCount(entry.usage.inputTokens)} ↓${formatCount(entry.usage.outputTokens)} tokens`
    );

    if (entry.usage.costUsd !== undefined) {
      parts.push(formatCost(entry.usage.costUsd));
    }
  }

  return (
    <Box marginBottom={1}>
      <Text dimColor>{`─ ${parts.join(" · ")}`}</Text>
    </Box>
  );
};

const NOTICE_COLORS = {
  dim: "gray",
  error: "red",
  warning: "yellow",
} as const;

interface EntryViewProps {
  readonly entry: Entry;
  readonly view: ChatView;
  readonly version: string;
  readonly columns: number;
}

/** One transcript entry. Ink prints it once, above the live area. */
export const EntryView = ({
  entry,
  view,
  version,
  columns,
}: EntryViewProps) => {
  switch (entry.kind) {
    case "banner": {
      return <Banner columns={columns} version={version} view={view} />;
    }

    case "user": {
      return (
        <Box marginTop={1}>
          <Box width={2}>
            <Text bold color="cyan">
              ›
            </Text>
          </Box>
          <Text bold>{entry.text}</Text>
        </Box>
      );
    }

    case "reply": {
      return (
        <Box marginTop={entry.first ? 1 : 0}>
          <Box flexShrink={0} width={LOGO_WIDTH}>
            <Text color="cyan">{entry.first ? "◉" : " "}</Text>
          </Box>
          <Text>{wrapLines(entry.lines, columns - LOGO_WIDTH)}</Text>
        </Box>
      );
    }

    case "tool": {
      return (
        <Box flexDirection="column" marginLeft={2}>
          <Box>
            <Text color={entry.ok ? "green" : "red"}>
              {entry.ok ? "✓ " : "✗ "}
            </Text>
            <Text bold>{entry.name}</Text>
            <Box flexShrink={1} marginLeft={1}>
              <Text dimColor wrap="truncate-end">
                {entry.input}
              </Text>
            </Box>
            <Text dimColor> {formatSeconds(entry.seconds)}</Text>
          </Box>
          {entry.ok || entry.output === "" ? undefined : (
            <Box marginLeft={2}>
              <Text color="red" dimColor>
                {previewLines(entry.output)}
              </Text>
            </Box>
          )}
        </Box>
      );
    }

    case "turn": {
      return <TurnLine entry={entry} />;
    }

    case "notice": {
      return (
        <Box marginLeft={2}>
          <Text color={NOTICE_COLORS[entry.tone]}>{entry.text}</Text>
        </Box>
      );
    }

    case "help": {
      return <Help />;
    }

    case "shell": {
      return (
        <Box marginLeft={2}>
          <Text dimColor>{entry.text}</Text>
        </Box>
      );
    }

    default: {
      const unknown: never = entry;

      throw new Error(`Unknown transcript entry: ${JSON.stringify(unknown)}`);
    }
  }
};
