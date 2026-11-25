import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { parseDuration } from "@wheatley/protocol";

import type { RpcHandlerMap } from "../contracts/module.js";
import { Deployment } from "./deployment.js";
import type { DeploymentOptions } from "./deployment.js";
import { createAgentRpc } from "./rpc/agent-handlers.js";
import { createDeploymentRpc } from "./rpc/deployment-handlers.js";
import { createRouter } from "./rpc/router.js";
import { ControlServer } from "./server/control-server.js";

/** The default TCP host of the Control Server: loopback only (ADR 0002). */
export const DEFAULT_DAEMON_HOST = "127.0.0.1";

/** The default TCP port of the Control Server. */
export const DEFAULT_DAEMON_PORT = 7420;

/** The Unix socket of the Control Server inside the Deployment home. */
export const DAEMON_SOCKET_FILE = "daemon.sock";

/** How long `close` waits for active Runs before it stops the Agents. */
export const DEFAULT_DRAIN_TIMEOUT = "30s";

const DRAIN_POLL_MS = 100;

/** Options of `startDaemon`. */
export interface DaemonOptions extends DeploymentOptions {
  /** Overrides `daemon.port` of `config.yaml`, for example 0 in tests. */
  readonly port?: number;
  /** Overrides `daemon.host` of `config.yaml`. */
  readonly host?: string;
  /** Overrides the Unix socket path. `null` disables the socket. */
  readonly socketPath?: string | null;
  /** The bundled dashboard folder that the Control Server serves on `/`. */
  readonly staticDir?: string;
  /**
   * Attaches Deployment-scoped services, such as the Webhook Ingress, after the Deployment reads `config.yaml` and
   * before any Agent starts.
   *
   * Ordering: the daemon calls the returned `close` after it stops every Agent, also if a later start step fails.
   *
   * Errors: if `attach` rejects, `startDaemon` closes the Deployment and rejects with the same error. `attach` must
   * stop the services that it started before it rejects.
   */
  readonly attach?: (deployment: Deployment) => Promise<AttachedServices>;
}

/** Deployment-scoped services that `DaemonOptions.attach` started. */
export interface AttachedServices {
  /** Stops the services. The daemon calls it once, after every Agent stopped. */
  readonly close: () => Promise<void>;
}

/** A running daemon. */
export interface Daemon {
  readonly deployment: Deployment;
  readonly server: ControlServer;
  /**
   * Stops the listeners, waits up to `daemon.drainTimeout` for active Runs, and stops every Agent. Runs that are still
   * active stay in storage and continue at the next start.
   */
  readonly close: () => Promise<void>;
}

/**
 * Starts a Deployment and its Control Server. The router sends Deployment methods to the Deployment, and Agent methods
 * to the core handlers and hosted modules of the named Agent.
 *
 * Errors: rejects if `attach`, the Agent start, or the Control Server listener fails. The Deployment and the attached
 * services are closed before the promise rejects.
 */
export const startDaemon = async (options: DaemonOptions): Promise<Daemon> => {
  const deployment = await Deployment.create(options);
  const snapshot = await deployment.config.read();
  const settings = snapshot.config.daemon;
  const agentRpc = new WeakMap<object, readonly RpcHandlerMap[]>();

  const router = createRouter({
    agent: async (name) => {
      const agent = await deployment.readyAgent(name);
      const cached = agentRpc.get(agent);

      if (cached !== undefined) {
        return cached;
      }

      const maps = [
        createAgentRpc(agent, deployment.agentDir(name)),
        ...agent.moduleRpc,
      ];

      agentRpc.set(agent, maps);

      return maps;
    },
    deployment: [createDeploymentRpc(deployment)],
    runningAgents: () =>
      deployment.agentNames.filter(
        (name) => deployment.health(name).state === "running"
      ),
  });

  let attached: AttachedServices | undefined;
  let server: ControlServer;

  try {
    attached = await options.attach?.(deployment);
    await deployment.start();
    server = await ControlServer.listen({
      allowedOrigins: settings?.allowedOrigins ?? [],
      events: deployment.events,
      host: options.host ?? settings?.host ?? DEFAULT_DAEMON_HOST,
      log: deployment.logs.logger("control-server"),
      port: options.port ?? settings?.port ?? DEFAULT_DAEMON_PORT,
      router,
      staticDir: options.staticDir,
      socketPath:
        options.socketPath === null
          ? undefined
          : (options.socketPath ??
            path.join(options.homeDir, DAEMON_SOCKET_FILE)),
      version: options.version,
    });
  } catch (error) {
    await deployment.close();
    await attached?.close();
    throw error;
  }

  const drainMs = parseDuration(
    settings?.drainTimeout ?? DEFAULT_DRAIN_TIMEOUT
  );

  return {
    close: async () => {
      await server.close();

      const deadline = Date.now() + drainMs;

      while (
        Date.now() < deadline &&
        deployment.status().agents.some((agent) => agent.activeRuns > 0)
      ) {
        // oxlint-disable-next-line no-await-in-loop -- The drain waits for Runs to end one poll at a time.
        await delay(DRAIN_POLL_MS);
      }

      await deployment.close();
      await attached?.close();
    },
    deployment,
    server,
  };
};
