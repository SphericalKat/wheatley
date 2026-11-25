import type { DaemonStatus } from "@wheatley/protocol";

import type { CliIo } from "./io.js";
import { connect } from "./session.js";
import type { ClientFlags } from "./session.js";

const MS_PER_SECOND = 1000;

/** Formats `system.status` as plain text lines. */
export const formatStatus = (status: DaemonStatus): string => {
  const lines = [
    `Wheatley ${status.version} (protocol ${status.protocolVersion}), up ${Math.round(status.uptimeMs / MS_PER_SECOND)}s`,
    "Agents:",
    ...status.agents.map((agent) => {
      const notes = [
        `${agent.activeRuns} active Runs`,
        agent.pendingRestart ? "restart pending" : undefined,
        agent.lastError === null ? undefined : `error: ${agent.lastError}`,
        agent.restartBackoffMs === null
          ? undefined
          : `retry in ${Math.round(agent.restartBackoffMs / MS_PER_SECOND)}s`,
      ].filter((note): note is string => note !== undefined);

      return `  ${agent.name}: ${agent.state} (${notes.join(", ")})`;
    }),
  ];

  if (status.agents.length === 0) {
    lines.push("  none");
  }

  if (status.concurrency.length > 0) {
    lines.push(
      "Model slots:",
      ...status.concurrency.map(
        (gate) =>
          `  ${gate.credential}: ${gate.inUse}/${gate.limit} in use, ${gate.waiting} waiting`
      )
    );
  }

  return `${lines.join("\n")}\n`;
};

/** `wheatley status`: prints Deployment health. Resolves with the exit code. */
export const runStatus = async (
  io: CliIo,
  flags: ClientFlags,
  version: string
): Promise<number> => {
  const client = await connect(io, flags, version);

  if (client === undefined) {
    return 1;
  }

  try {
    io.stdout(formatStatus(await client.request("system.status", {})));

    return 0;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);

    return 1;
  } finally {
    await client.close();
  }
};
