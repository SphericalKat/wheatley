import { BUILTIN_COMMANDS } from "@wheatley-ai/sdk";

/** One slash command of the interactive chat. */
export interface ChatCommand {
  /** The full command, for example `/model`. */
  readonly word: string;
  /** A hint for the argument, for example `<model-id>`. */
  readonly argument?: string;
  readonly description: string;
  /** True for a command that the terminal runs itself instead of the Agent. */
  readonly local: boolean;
}

/** The commands that the terminal runs without the Agent. */
export const LOCAL_COMMANDS = {
  copy: "/copy",
  exit: "/exit",
  help: "/help",
  quit: "/quit",
} as const;

export const CHAT_COMMANDS: readonly ChatCommand[] = [
  ...BUILTIN_COMMANDS.map((command) => ({
    argument: "argument" in command ? command.argument : undefined,
    description: command.description,
    local: false,
    word: `/${command.name}`,
  })),
  {
    description: "Copy the last reply to the clipboard",
    local: true,
    word: LOCAL_COMMANDS.copy,
  },
  {
    description: "List the commands and keys",
    local: true,
    word: LOCAL_COMMANDS.help,
  },
  { description: "End the chat", local: true, word: LOCAL_COMMANDS.exit },
];

/** The command name and its argument hint, for example `/model <model-id>`. */
export const commandLabel = (command: ChatCommand): string =>
  command.argument === undefined
    ? command.word
    : `${command.word} ${command.argument}`;

const COMMAND_NAME = /^\/[a-z-]*$/u;
const WORD_SPLIT = /\s+/u;

const RANK = {
  descriptionPrefix: 3,
  descriptionWord: 4,
  namePrefix: 0,
  nameSubstring: 1,
} as const;

const rankOf = (command: ChatCommand, query: string): number | undefined => {
  const name = command.word.slice(1);

  if (name.startsWith(query)) {
    return RANK.namePrefix;
  }

  if (name.includes(query)) {
    return RANK.nameSubstring;
  }

  const words = command.description.toLowerCase().split(WORD_SPLIT);

  if (words.some((word) => word.startsWith(query))) {
    return words[0]?.startsWith(query) === true
      ? RANK.descriptionPrefix
      : RANK.descriptionWord;
  }

  return undefined;
};

/**
 * The commands for the menu while `line` is a command name without arguments, best first: a name that starts with the
 * query, then a name that contains it, then a description word that starts with it. Returns no commands otherwise.
 */
export const matchCommands = (line: string): readonly ChatCommand[] => {
  if (!COMMAND_NAME.test(line)) {
    return [];
  }

  const query = line.slice(1);

  return CHAT_COMMANDS.flatMap((command, index) => {
    const rank = rankOf(command, query);

    return rank === undefined ? [] : [{ command, index, rank }];
  })
    .toSorted((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ command }) => command);
};

const editDistance = (a: string, b: string): number => {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);

  // Command words are ASCII, so code units are characters here.
  for (let i = 0; i < a.length; i += 1) {
    const current = [i + 1];

    for (let j = 0; j < b.length; j += 1) {
      current.push(
        Math.min(
          (previous[j + 1] ?? 0) + 1,
          (current[j] ?? 0) + 1,
          (previous[j] ?? 0) + (a[i] === b[j] ? 0 : 1)
        )
      );
    }

    previous = current;
  }

  return previous[b.length] ?? 0;
};

const MAX_SUGGESTION_DISTANCE = 2;

/** The known command closest to an unknown `word`, if one is at most two edits away. */
export const suggestCommand = (word: string): string | undefined => {
  const scored = CHAT_COMMANDS.map((command) => ({
    distance: editDistance(word, command.word),
    word: command.word,
  })).toSorted((a, b) => a.distance - b.distance);

  const [best] = scored;

  return best !== undefined && best.distance <= MAX_SUGGESTION_DISTANCE
    ? best.word
    : undefined;
};

const COMMAND_LINE = /^\/[a-z][a-z-]*(?:\s|$)/u;

/** True if `line` looks like a slash command, for example `/stop` or `/model x`, and not like a path such as `/etc/x`. */
export const isCommandLine = (line: string): boolean => COMMAND_LINE.test(line);
