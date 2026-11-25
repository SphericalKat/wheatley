import type { DaemonStatus } from "@wheatley/protocol";

import type { RpcClient } from "../rpc/client.js";
import { createStore, errorMessage } from "../store.js";
import type { Store } from "../store.js";

/** The Overview: daemon status and the health of every Agent. */
export interface DeploymentState {
  readonly loading: boolean;
  readonly error: string | null;
  readonly status: DaemonStatus | null;
  /** The last failed Agent action, for example a start of a degraded Agent. */
  readonly actionError: string | null;
}

/** The Deployment model. It reloads on Agent, config, and Run events and after each reconnect. */
export interface Deployment {
  readonly state: Store<DeploymentState>;
  readonly refresh: () => Promise<void>;
  /** Starts, stops, or restarts one Agent. Never rejects. On failure, `actionError` holds the reason. */
  readonly control: (
    agent: string,
    action: "start" | "stop" | "restart"
  ) => Promise<void>;
  readonly dispose: () => void;
}

/** Returns the Agent names of the Deployment, in config order. */
export const agentNames = (state: DeploymentState): readonly string[] =>
  state.status?.agents.map((agent) => agent.name) ?? [];

/** Creates the Deployment model and loads it once the client is ready. */
export const createDeployment = (client: RpcClient): Deployment => {
  const state = createStore<DeploymentState>({
    actionError: null,
    error: null,
    loading: true,
    status: null,
  });

  const refresh = async (): Promise<void> => {
    try {
      const status = await client.call("system.status", {});

      state.update((current) => ({
        ...current,
        error: null,
        loading: false,
        status,
      }));
    } catch (error) {
      state.update((current) => ({
        ...current,
        error: errorMessage(error),
        loading: false,
      }));
    }
  };

  const reload = (): void => {
    void refresh();
  };

  const offs = [
    client.onReady(reload),
    client.on("agent.status", reload),
    client.on("config.changed", reload),
    client.on("run.started", reload),
    client.on("run.finished", reload),
  ];

  if (client.state.get().status === "open") {
    reload();
  }

  return {
    control: async (agent, action) => {
      state.update((current) => ({ ...current, actionError: null }));

      try {
        if (action === "start") {
          await client.call("agents.start", { agent });
        } else if (action === "stop") {
          await client.call("agents.stop", { agent });
        } else {
          await client.call("agents.restart", { agent });
        }

        await refresh();
      } catch (error) {
        state.update((current) => ({
          ...current,
          actionError: `${agent}: ${errorMessage(error)}`,
        }));
      }
    },
    dispose: () => {
      for (const off of offs) {
        off();
      }
    },
    refresh,
    state,
  };
};
