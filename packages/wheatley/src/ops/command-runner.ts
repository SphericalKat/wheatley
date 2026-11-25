import { spawn } from "node:child_process";
import { once } from "node:events";

/** How an external command ended. */
export interface CommandResult {
  /** The exit code, or 1 if a signal ended the command. */
  readonly exitCode: number;
  /** Empty if the command inherited the standard streams. */
  readonly stdout: string;
  /** Empty if the command inherited the standard streams. */
  readonly stderr: string;
}

export interface CommandOptions {
  /** Connects the command to the standard streams of this process, for example for `npm install` progress. */
  readonly inheritStdio?: boolean;
}

/**
 * Runs external programs such as `systemctl`, `launchctl`, `npm`, and `pnpm`. Tests replace it at this third-party
 * boundary.
 */
export interface CommandRunner {
  /**
   * Runs `command` with `args`, without a shell, and resolves when the command exits, also for a non-zero exit code.
   *
   * Errors: rejects only if the command cannot start, for example with `ENOENT` if it is not installed.
   */
  readonly run: (
    command: string,
    args: readonly string[],
    options?: CommandOptions
  ) => Promise<CommandResult>;
}

/** Runs commands as child processes of this process. */
export const processRunner: CommandRunner = {
  run: async (command, args, options) => {
    const child = spawn(command, args, {
      stdio:
        options?.inheritStdio === true ? "inherit" : ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    // `once` rejects with the `error` event, for example `ENOENT` if the command is not installed.
    await once(child, "close");

    const ended =
      child.signalCode === null ? "" : `Terminated by ${child.signalCode}\n`;

    return {
      exitCode: child.exitCode ?? 1,
      stderr: `${stderr}${ended}`,
      stdout,
    };
  },
};

/** Formats a failed command for an error message. */
export const describeFailure = (
  command: string,
  args: readonly string[],
  result: CommandResult
): string => {
  const output = result.stderr.trim() || result.stdout.trim();
  const detail = output === "" ? "" : `: ${output}`;

  return `${[command, ...args].join(" ")} exited with code ${result.exitCode}${detail}`;
};
