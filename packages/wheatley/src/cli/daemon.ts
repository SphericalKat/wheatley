import { once } from "node:events";
import { readFile } from "node:fs/promises";

import { ConfigIssueSchema, decode } from "@wheatley-ai/protocol";
import { Type } from "typebox";

import { SeamError } from "../contracts/errors.js";
import { renderConfigDiagnostics } from "../core/config/diagnostics.js";
import { errorMessage } from "../core/error-message.js";
import { startWheatley } from "../wiring/daemon.js";
import type { WheatleyOptions } from "../wiring/daemon.js";
import type { CliIo } from "./io.js";

/** Options of `wheatley daemon`. */
export interface DaemonCommandOptions {
  readonly home: string;
  readonly host: string | undefined;
  readonly port: number | undefined;
  readonly version: string;
  /** Overrides for embedding, for example a fake model provider in tests. */
  readonly overrides?: Partial<WheatleyOptions>;
}

/** The `details` of a `config_invalid` error for a file on disk. */
const FileIssuesSchema = Type.Object({
  file: Type.String(),
  issues: Type.Array(ConfigIssueSchema),
});

/** True if stderr is a terminal and `NO_COLOR` is not set to a non-empty value (https://no-color.org). */
const useColor = (io: CliIo): boolean =>
  io.stderrIsTTY === true && (io.env.NO_COLOR ?? "") === "";

/**
 * Renders the source diagnostics of a `config_invalid` error, or returns `undefined` for any other error or if the file
 * cannot be read.
 */
const configDiagnostics = async (
  io: CliIo,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- A caught value has no type.
  error: unknown
): Promise<string | undefined> => {
  if (!(error instanceof SeamError) || error.code !== "config_invalid") {
    return undefined;
  }

  const details = decode(FileIssuesSchema, error.details ?? null);

  if (!details.ok) {
    return undefined;
  }

  const { file, issues } = details.value;

  try {
    const source = await readFile(file, "utf-8");

    return renderConfigDiagnostics({
      color: useColor(io),
      file,
      issues,
      source,
    });
  } catch {
    // The file changed or vanished after the failed read: report the error without a snippet.
    return undefined;
  }
};

/**
 * `wheatley daemon`: runs the Deployment with every module, the Webhook Ingress, and the Control Server in the
 * foreground until `SIGINT` or `SIGTERM`, then drains and stops. Log records go to stderr as JSON lines. Resolves with
 * the exit code.
 */
export const runDaemon = async (
  io: CliIo,
  options: DaemonCommandOptions
): Promise<number> => {
  let daemon: Awaited<ReturnType<typeof startWheatley>>;

  try {
    daemon = await startWheatley({
      env: io.env,
      homeDir: options.home,
      host: options.host,
      port: options.port,
      version: options.version,
      writeLog: (record) => {
        io.stderr(`${JSON.stringify(record)}\n`);
      },
      ...options.overrides,
    });
  } catch (error) {
    const diagnostics = await configDiagnostics(io, error);

    if (diagnostics !== undefined) {
      io.stderr(`${diagnostics}\n`);
    }

    io.stderr(`Cannot start the daemon: ${errorMessage(error)}\n`);

    return 1;
  }

  io.stdout(`Wheatley ${options.version} listens on ${daemon.server.url}\n`);

  if (!io.shutdown.aborted) {
    await once(io.shutdown, "abort");
  }

  io.stdout("Stopping...\n");
  await daemon.close();

  return 0;
};
