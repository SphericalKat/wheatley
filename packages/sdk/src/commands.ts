/** The built-in Chat commands, without the leading slash (ADR 0007). */
export type CommandName =
  | "new"
  | "model"
  | "compact"
  | "stop"
  | "goal"
  | "status"
  | "restart";

/** A built-in Chat command. Frontend Bindings register these as native platform commands. */
export interface CommandSpec {
  readonly name: CommandName;
  readonly description: string;
  /** A short hint for the argument, for example `<model-id>`. Absent if the command takes no argument. */
  readonly argument?: string;
}

/** The seven built-in Chat commands, in menu order. */
export const BUILTIN_COMMANDS = [
  { description: "Start a new Conversation in this Chat", name: "new" },
  {
    argument: "<model-id>",
    description: "Use another model for this Conversation",
    name: "model",
  },
  { description: "Compact the current Conversation", name: "compact" },
  { description: "Stop the active Run in this Chat", name: "stop" },
  {
    argument: "<objective>",
    description: "Start a long-running autonomous Run",
    name: "goal",
  },
  {
    description: "Show the Conversation, Run, model, and Agent health",
    name: "status",
  },
  { description: "Restart this Agent", name: "restart" },
] as const satisfies readonly CommandSpec[];

/** A Chat command parsed from message text. */
export interface ParsedCommand {
  readonly name: CommandName;
  /** The trimmed text after the command, or `undefined` if none follows. */
  readonly args: string | undefined;
}

const COMMAND_TEXT = /^\/(?<name>[a-z]+)(?:@\S+)?(?:\s+(?<args>[\s\S]*))?$/u;

const isCommandName = (name: string): name is CommandName =>
  BUILTIN_COMMANDS.some((command) => command.name === name);

/**
 * Parses `/name args` into a built-in command.
 *
 * Accepts a Telegram-style bot suffix (`/new@my_bot`). Returns `undefined` if the text is not a built-in command, so
 * the Frontend Binding sends it as a normal message.
 */
export const parseCommandText = (text: string): ParsedCommand | undefined => {
  const match = COMMAND_TEXT.exec(text.trim());
  const name = match?.groups?.name;

  if (name === undefined || !isCommandName(name)) {
    return undefined;
  }

  const args = match?.groups?.args?.trim();

  return { args: args === undefined || args === "" ? undefined : args, name };
};
