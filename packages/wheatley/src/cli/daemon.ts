import { once } from "node:events";

import { startDaemon } from "../core/daemon.js";
import type { DaemonOptions } from "../core/daemon.js";
import type { CliIo } from "./io.js";

/** Options of `wheatley daemon`. */
export interface DaemonCommandOptions {
  readonly home: string;
  readonly host: string | undefined;
  readonly port: number | undefined;
  readonly version: string;
  /** Overrides for embedding, for example a fake model provider in tests. */
  readonly overrides?: Partial<DaemonOptions>;
}

/**
 * `wheatley daemon`: runs the Deployment and the Control Server in the foreground until `SIGINT` or `SIGTERM`, then
 * drains and stops. Log records go to stderr as JSON lines. Resolves with the exit code.
 */
export const runDaemon = async (
  io: CliIo,
  options: DaemonCommandOptions
): Promise<number> => {
  let daemon: Awaited<ReturnType<typeof startDaemon>>;

  try {
    daemon = await startDaemon({
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
    io.stderr(
      `Cannot start the daemon: ${error instanceof Error ? error.message : String(error)}\n`
    );

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
