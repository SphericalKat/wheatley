import { simulateIo } from "../contracts/fake-io.js";
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
} from "./command-runner.js";

/** One command that the fake ran. */
export interface RecordedCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly inheritStdio: boolean;
}

/** Decides the result of one command. Return `undefined` for exit code 0 and no output. */
export type CommandScript = (
  command: string,
  args: readonly string[]
) => Partial<CommandResult> | undefined;

/** A `CommandRunner` that records every command and answers from a script instead of starting processes. */
export class FakeCommandRunner implements CommandRunner {
  readonly commands: RecordedCommand[] = [];
  readonly #script: CommandScript | undefined;

  constructor(script?: CommandScript) {
    this.#script = script;
  }

  readonly run = async (
    command: string,
    args: readonly string[],
    options?: CommandOptions
  ): Promise<CommandResult> => {
    await simulateIo();
    this.commands.push({
      args: [...args],
      command,
      inheritStdio: options?.inheritStdio === true,
    });

    const result = this.#script?.(command, args);

    return {
      exitCode: result?.exitCode ?? 0,
      stderr: result?.stderr ?? "",
      stdout: result?.stdout ?? "",
    };
  };

  /** The commands as `command arg ...` lines. */
  get lines(): string[] {
    return this.commands.map(({ command, args }) =>
      [command, ...args].join(" ")
    );
  }
}
