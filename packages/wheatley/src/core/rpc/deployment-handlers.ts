import type { RpcHandlerMap } from "../../contracts/module.js";
import type { Deployment } from "../deployment.js";

/** The default number of records that `logs.tail` returns. */
export const DEFAULT_LOG_TAIL = 200;

/**
 * The Deployment-wide JSON-RPC handlers: Agent lifecycle (`agents.*`), config (`config.*`), secrets (`secrets.*`),
 * `system.status`, and `logs.tail`. The Control Server handles `system.hello` and `events.*` per connection.
 */
export const createDeploymentRpc = (deployment: Deployment): RpcHandlerMap => ({
  "agents.create": async (params) =>
    await deployment.createAgent(
      params.agent,
      params.config,
      params.expectedRevision
    ),
  "agents.delete": async (params) => await deployment.deleteAgent(params),
  "agents.get": async (params) => {
    await Promise.resolve();

    return deployment.health(params.agent);
  },
  "agents.list": async () => {
    await Promise.resolve();

    return {
      agents: deployment.agentNames.map((name) => deployment.health(name)),
    };
  },
  "agents.rename": async (params) =>
    await deployment.renameAgent(
      params.agent,
      params.newName,
      params.expectedRevision
    ),
  "agents.restart": async (params) => ({
    state: await deployment.restartAgent(params.agent),
  }),
  "agents.start": async (params) => ({
    state: await deployment.startAgent(params.agent),
  }),
  "agents.stop": async (params) => ({
    state: await deployment.stopAgent(params.agent),
  }),
  "config.get": async () => await deployment.getConfig(),
  "config.save": async (params) =>
    await deployment.saveConfig(
      "raw" in params ? { raw: params.raw } : { config: params.config },
      params.expectedRevision,
      params.restart ?? "none"
    ),
  "config.validate": async (params) => {
    const issues = await deployment.config.validate(params.raw);

    return { issues: [...issues], valid: issues.length === 0 };
  },
  "logs.tail": async (params) => {
    await Promise.resolve();

    return {
      records: deployment.logs.tail({
        agent: params.agent,
        level: params.level,
        limit: params.limit ?? DEFAULT_LOG_TAIL,
        module: params.module,
      }),
    };
  },
  "secrets.delete": async (params) => ({
    deleted: await deployment.config.secrets.delete(params.name),
  }),
  "secrets.list": async () => ({
    secrets: [...(await deployment.config.secrets.list())],
  }),
  "secrets.reveal": async (params) => ({
    value: await deployment.config.secrets.reveal(params.name),
  }),
  "secrets.set": async (params) => ({
    source: await deployment.config.secrets.set(params.name, params.value),
  }),
  "system.status": async () => {
    await Promise.resolve();

    return deployment.status();
  },
});
