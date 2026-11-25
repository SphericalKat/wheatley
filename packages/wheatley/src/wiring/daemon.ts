import { systemClock } from "../contracts/module.js";
import type { DeploymentModuleContext } from "../contracts/module.js";
import type { TriggerRuntime } from "../contracts/trigger-runtime.js";
import { startDaemon } from "../core/daemon.js";
import type { Daemon, DaemonOptions } from "../core/daemon.js";
import type { Deployment } from "../core/deployment.js";
import { dashboardAssetsDir } from "../ops/dashboard-assets.js";
import { opsModule } from "../ops/module.js";
import type { OpsApi } from "../ops/module.js";
import { webhookIngressModule } from "../triggers/module.js";
import type { WebhookIngressModuleApi } from "../triggers/module.js";
import { createAgentServices } from "./agent-services.js";
import { createExtensionCatalog } from "./catalog.js";
import type { ExtensionCatalogOptions } from "./catalog.js";

/** Options of `startWheatley`. */
export interface WheatleyOptions extends Omit<
  DaemonOptions,
  "extensions" | "agentServices" | "attach"
> {
  /** Options of the Deployment's extension catalog, for example built-in Frontends with fake platform clients. */
  readonly catalog?: ExtensionCatalogOptions;
}

/** A running Wheatley daemon with its Deployment-scoped modules. */
export interface WheatleyDaemon extends Daemon {
  /**
   * The Webhook Ingress. It listens only if `webhooks` in `config.yaml` enables it, and `close` stops it after every
   * Agent stops.
   */
  readonly ingress: WebhookIngressModuleApi;
  /** The ops module: migrations with a pre-migration backup, the backup list, and the dashboard assets folder. */
  readonly ops: OpsApi;
}

/** The Deployment-scoped modules, created once the Deployment exists. */
interface DeploymentModules {
  ingress: WebhookIngressModuleApi | undefined;
  ops: OpsApi | undefined;
}

const requireModule = <T>(value: T | undefined, name: string): T => {
  if (value === undefined) {
    throw new Error(`The ${name} module did not start`);
  }

  return value;
};

/**
 * Starts the complete Wheatley daemon: the Deployment with every v1 module, the Webhook Ingress, and the Control Server
 * that serves the dashboard on `/` and JSON-RPC on `/ws`.
 *
 * Wiring:
 * - The extension catalog gives each Agent its built-in Tools, Plugins, MCP Servers, Skills, and Frontends.
 * - Each Agent mounts the outbox, Approvals, Memory, Triggers, and its Frontend Bindings as hosted modules.
 * - The ops module backs up `agent.sqlite` before migrations. A failed migration leaves the Agent `degraded`.
 * - The Webhook Ingress routes Trigger webhooks and Frontend routes to running Agents.
 */
export const startWheatley = async (
  options: WheatleyOptions
): Promise<WheatleyDaemon> => {
  const clock = options.clock ?? systemClock;
  const modules: DeploymentModules = { ingress: undefined, ops: undefined };
  const triggerRuntimes = new Map<string, TriggerRuntime>();
  let deploymentRef: Deployment | undefined;

  const attach = async (deployment: Deployment) => {
    deploymentRef = deployment;

    const snapshot = await deployment.config.read();

    const context = (name: string): DeploymentModuleContext => ({
      clock,
      events: deployment.events,
      homeDir: options.homeDir,
      log: deployment.logs.logger(name),
    });

    const ops = await opsModule.create(context("ops"), {});

    modules.ops = ops.api;

    const ingress = await webhookIngressModule.create(context("webhooks"), {
      agent: (name) =>
        deployment.agentNames.includes(name)
          ? {
              state: () => deployment.health(name).state,
              triggers: () => triggerRuntimes.get(name),
            }
          : undefined,
      config: snapshot.config.webhooks,
      secrets: deployment.config.secrets,
    });

    modules.ingress = ingress.api;
    await ingress.start?.();

    return {
      close: async () => {
        await ingress.stop?.();
      },
    };
  };

  const agentServices: DaemonOptions["agentServices"] = (agent, config) => {
    const deployment = requireModule(deploymentRef, "Deployment");
    const ingress = requireModule(modules.ingress, "webhook ingress");

    return createAgentServices({
      config: deployment.config,
      events: deployment.events,
      migrateAgent: modules.ops?.migrateAgent,
      registerRoute: ingress.enabled
        ? ingress.registerFrontendRoute
        : undefined,
      triggerRuntimes,
    })(agent, config);
  };

  const daemon = await startDaemon({
    ...options,
    agentServices,
    attach,
    extensions: createExtensionCatalog(options.catalog),
    staticDir: options.staticDir ?? dashboardAssetsDir(),
  });

  return {
    ...daemon,
    ingress: requireModule(modules.ingress, "webhook ingress"),
    ops: requireModule(modules.ops, "ops"),
  };
};
