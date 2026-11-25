import type { AgentConfig } from "@wheatley/protocol";

import { createApprovalGate } from "../approvals/gate.js";
import { approvalsModule } from "../approvals/module.js";
import { createApprovalsRpc } from "../approvals/rpc.js";
import type { ConfigStore } from "../contracts/config-store.js";
import type { DeliveryOutbox } from "../contracts/delivery-outbox.js";
import { SeamError } from "../contracts/errors.js";
import { migrationNamespace } from "../contracts/module.js";
import type { TriggerRuntime } from "../contracts/trigger-runtime.js";
import type { HostedModule } from "../core/agent/agent.js";
import type { ApprovalGateFactory } from "../core/agent/policy-gate.js";
import type { AgentServices } from "../core/deployment.js";
import type { EventBus } from "../core/events.js";
import { memoryModule } from "../memory/module.js";
import type { MemoryApi } from "../memory/module.js";
import type { OpsApi } from "../ops/module.js";
import { deliveryOutboxModule, triggersModule } from "../triggers/module.js";
import type { TriggersModuleApi } from "../triggers/module.js";
import { createFrontendHost } from "./frontend-host.js";
import type { RegisterFrontendRoute } from "./frontend-host.js";

/** The migration namespace of the Frontend host. It owns no tables: bindings keep state in their `dataDir`. */
const FRONTENDS_NAMESPACE = "frontends";

/** What the Agent modules need from the Deployment. */
export interface AgentServicesDeps {
  /** The Config Store: `allow_always` prepends rules through it, and the gate redacts previews with its secrets. */
  readonly config: ConfigStore;
  /** The Deployment event bus, for live Run progress in Frontend Bindings. */
  readonly events: EventBus;
  /** Absent while the Webhook Ingress is disabled. */
  readonly registerRoute?: RegisterFrontendRoute;
  /** Migrates `agent.sqlite` with a pre-migration backup. Without it, the Agent migrates directly. */
  readonly migrateAgent?: OpsApi["migrateAgent"];
  /** The Trigger runtime of each Agent while its Triggers module runs, for the Webhook Ingress. */
  readonly triggerRuntimes?: Map<string, TriggerRuntime>;
}

/** Module APIs that exist only after the Agent mounts its modules. */
interface MountedApis {
  outbox: DeliveryOutbox | undefined;
  memory: MemoryApi | undefined;
  triggers: TriggersModuleApi | undefined;
}

const notMounted = (module: string): SeamError =>
  new SeamError("agent_unavailable", `The ${module} module is not mounted`);

/**
 * Builds the services of one Agent start: the Approval gate, the outbox, Memory, Triggers, and Frontend Bindings.
 *
 * Module order matters. The outbox mounts first, because the gate, the Triggers, and the bindings enqueue into it.
 * The Frontend host mounts last, so its bindings start after the outbox runs.
 */
export const createAgentServices =
  (deps: AgentServicesDeps) =>
  (agent: string, config: AgentConfig): AgentServices => {
    const apis: MountedApis = {
      memory: undefined,
      outbox: undefined,
      triggers: undefined,
    };

    const requireOutbox = (): DeliveryOutbox => {
      if (apis.outbox === undefined) {
        throw notMounted("outbox");
      }

      return apis.outbox;
    };

    const requireMemory = (): MemoryApi => {
      if (apis.memory === undefined) {
        throw notMounted("memory");
      }

      return apis.memory;
    };

    const frontends = createFrontendHost({
      config,
      events: deps.events,
      registerRoute: deps.registerRoute,
      secrets: deps.config.secrets,
    });

    const outboxModule: HostedModule = {
      migrations: migrationNamespace(deliveryOutboxModule),
      mount: async (ctx, host) => {
        const instance = await deliveryOutboxModule.create(ctx, {
          deliver: frontends.deliver,
          onDelivered: host.recordDelivered,
        });

        apis.outbox = instance.api;

        return instance;
      },
    };

    const approvalsRpcModule: HostedModule = {
      migrations: migrationNamespace(approvalsModule),
      mount: async (_ctx, host) => {
        await Promise.resolve();

        return { rpc: createApprovalsRpc(host.approvals) };
      },
    };

    const memoryHosted: HostedModule = {
      migrations: migrationNamespace(memoryModule),
      mount: async (ctx, host) => {
        const instance = await memoryModule.create(ctx, {
          config: config.memory,
          maintenance: host.maintenance,
        });

        apis.memory = instance.api;

        return { ...instance, tools: instance.api.tools };
      },
    };

    const triggersHosted: HostedModule = {
      migrations: migrationNamespace(triggersModule),
      mount: async (ctx, host) => {
        const instance = await triggersModule.create(ctx, {
          runner: host.triggers,
        });

        const { runtime } = instance.api;

        apis.triggers = instance.api;

        return {
          rpc: instance.rpc,
          start: async () => {
            await instance.start?.();
            deps.triggerRuntimes?.set(agent, runtime);
          },
          stop: async () => {
            if (deps.triggerRuntimes?.get(agent) === runtime) {
              deps.triggerRuntimes.delete(agent);
            }

            await instance.stop?.();
          },
          tools: instance.api.tools,
        };
      },
    };

    const frontendsHosted: HostedModule = {
      migrations: { migrations: [], namespace: FRONTENDS_NAMESPACE },
      mount: frontends.mount,
    };

    const approvals: ApprovalGateFactory = (host) =>
      createApprovalGate(
        {
          agentName: host.agentName,
          clock: host.clock,
          db: host.db,
          events: host.events,
          log: host.log,
        },
        {
          config: deps.config,
          defaultAction: host.defaultAction,
          outbox: {
            enqueue: async (item) => await requireOutbox().enqueue(item),
          },
          policy: host.policy,
          secrets: deps.config.secrets,
          timeoutMs: host.timeoutMs,
          wake: host.wake,
        }
      );

    const { migrateAgent } = deps;

    return {
      approvals,
      isDeliverySuppressed: async (runId) =>
        (await apis.triggers?.runtime.isDeliverySuppressed(runId)) ?? false,
      memory: {
        archive: async (message) => {
          await requireMemory().store.archive(message);
        },
        compactionFlushPrompt: () => apis.memory?.store.compactionFlushPrompt(),
        snapshot: async () => await requireMemory().store.snapshot(),
      },
      migrate:
        migrateAgent === undefined
          ? undefined
          : async (db, namespaces) => {
              const report = await migrateAgent(agent, db, namespaces);

              if (report.outcome === "degraded") {
                throw new Error(report.error, { cause: report.cause });
              }
            },
      modules: [
        outboxModule,
        approvalsRpcModule,
        memoryHosted,
        triggersHosted,
        frontendsHosted,
      ],
      outbox: { enqueue: async (item) => await requireOutbox().enqueue(item) },
    };
  };
