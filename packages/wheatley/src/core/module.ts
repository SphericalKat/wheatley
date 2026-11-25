// The entry module of the core runtime track, so that Wave 2 wiring is mechanical:
// - `coreDeploymentModule` creates the Deployment, and `startDaemon` adds the Control Server.
// - `coreAgentModule` serves the core Agent methods of one running Agent.
// - `coreMigrations` are the `core` tables of `agent.sqlite`. `Agent.open` applies them itself, before any module.
// - `createDeploymentRpc` and `createAgentRpc` are the JSON-RPC handler maps.
import type { AgentModule, DeploymentModule } from "../contracts/module.js";
import { CORE_NAMESPACE, coreMigrations } from "./agent/agent-store.js";
import type { Agent } from "./agent/agent.js";
import { Deployment } from "./deployment.js";
import type { DeploymentOptions } from "./deployment.js";
import { createAgentRpc } from "./rpc/agent-handlers.js";
import { createDeploymentRpc } from "./rpc/deployment-handlers.js";

export { coreMigrations } from "./agent/agent-store.js";

export { startDaemon } from "./daemon.js";

export { createAgentRpc } from "./rpc/agent-handlers.js";

export { createDeploymentRpc } from "./rpc/deployment-handlers.js";

/** The dependencies of `coreDeploymentModule`: the Deployment options without the home folder from the context. */
export type CoreDeploymentDeps = Omit<DeploymentOptions, "homeDir" | "clock">;

/**
 * The Deployment as a Deployment-scoped module. `create` reads `config.yaml`, `start` starts every Agent, and `stop`
 * stops them. Its `rpc` serves `agents.*`, `config.*`, `secrets.*`, `system.status`, and `logs.tail`.
 */
export const coreDeploymentModule: DeploymentModule<
  CoreDeploymentDeps,
  Deployment
> = {
  create: async (ctx, deps) => {
    const deployment = await Deployment.create({
      ...deps,
      clock: ctx.clock,
      homeDir: ctx.homeDir,
    });

    return {
      api: deployment,
      rpc: createDeploymentRpc(deployment),
      start: deployment.start,
      stop: deployment.close,
    };
  },
  name: "core",
  scope: "deployment",
};

/** The dependencies of `coreAgentModule`: the running Agent that it serves. */
export interface CoreAgentDeps {
  readonly agent: Agent;
}

/**
 * The core methods of one Agent as an Agent-scoped module: `chat.*`, `runs.*`, and `extensions.list`. Its migrations
 * are `coreMigrations`, which `Agent.open` already applies, so do not pass it to `AgentOptions.modules`.
 */
export const coreAgentModule: AgentModule<CoreAgentDeps, Agent> = {
  create: (ctx, deps) => ({
    api: deps.agent,
    rpc: createAgentRpc(deps.agent, ctx.agentDir),
  }),
  migrations: coreMigrations,
  name: CORE_NAMESPACE,
  scope: "agent",
};
