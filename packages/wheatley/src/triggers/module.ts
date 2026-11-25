import type { WebhooksConfig } from "@wheatley/protocol";

import type {
  DeliveryOutbox,
  DeliveryOutboxDeps,
} from "../contracts/delivery-outbox.js";
import type { ToolProvider } from "../contracts/extension-catalog.js";
import type { AgentModule, DeploymentModule } from "../contracts/module.js";
import type {
  TriggerRunner,
  TriggerRuntime,
} from "../contracts/trigger-runtime.js";
import type {
  WebhookIngress,
  WebhookIngressDeps,
} from "../contracts/webhook-ingress.js";
import { SqliteDeliveryOutbox } from "./delivery-outbox.js";
import {
  OUTBOX_NAMESPACE,
  outboxMigrations,
  TRIGGERS_NAMESPACE,
  triggersMigrations,
} from "./migrations.js";
import { createOutboxRpc, createTriggerRpc } from "./rpc.js";
import { SqliteTriggerRuntime } from "./trigger-runtime.js";
import { createTriggerToolProvider } from "./trigger-tools.js";
import {
  DEFAULT_WEBHOOK_HOST,
  DEFAULT_WEBHOOK_PORT,
  HttpWebhookIngress,
} from "./webhook-ingress.js";

export {
  OUTBOX_NAMESPACE,
  outboxMigrations,
  TRIGGERS_NAMESPACE,
  triggersMigrations,
} from "./migrations.js";

export { createOutboxRpc, createTriggerRpc } from "./rpc.js";

/** What the Triggers module needs from its Agent. */
export interface TriggersModuleDeps {
  readonly runner: TriggerRunner;
  /** The Frontend Binding IDs of the Agent, including `cli`. Trigger Tools accept only these as a target. */
  readonly bindingIds: readonly string[];
}

/** The API of the Triggers module for the Agent. */
export interface TriggersModuleApi {
  readonly runtime: TriggerRuntime;
  /** The Tools `schedule_trigger`, `list_triggers`, `cancel_trigger`, and `suppress_delivery`. */
  readonly tools: ToolProvider;
}

/**
 * The Triggers module of an Agent (ADR 0010): the Trigger runtime and scheduler over `agent.sqlite`, the Trigger
 * Tools, and the `triggers.*` JSON-RPC handlers. `start` starts the scheduler, and `stop` stops it.
 */
export const triggersModule: AgentModule<
  TriggersModuleDeps,
  TriggersModuleApi
> = {
  create: (ctx, deps) => {
    const runtime = new SqliteTriggerRuntime({
      agentName: ctx.agentName,
      clock: ctx.clock,
      db: ctx.db,
      events: ctx.events,
      log: ctx.log,
      runner: deps.runner,
    });

    return {
      api: {
        runtime,
        tools: createTriggerToolProvider({
          bindingIds: deps.bindingIds,
          clock: ctx.clock,
          runtime,
          suppressDelivery: runtime.suppressDelivery,
        }),
      },
      rpc: createTriggerRpc(runtime),
      start: runtime.start,
      stop: runtime.stop,
    };
  },
  migrations: triggersMigrations,
  name: TRIGGERS_NAMESPACE,
  scope: "agent",
};

/** What the Delivery Outbox module needs from its Agent. */
export interface DeliveryOutboxModuleDeps extends DeliveryOutboxDeps {
  /** Returns a number in `[0, 1)` for backoff jitter. The default is `Math.random`. */
  readonly random?: () => number;
}

/**
 * The Delivery Outbox module of an Agent (ADR 0007, ADR 0010): the durable FIFO outbox over `agent.sqlite` and the
 * `deliveries.*` JSON-RPC handlers. `start` starts deliveries, and `stop` stops them.
 */
export const deliveryOutboxModule: AgentModule<
  DeliveryOutboxModuleDeps,
  DeliveryOutbox
> = {
  create: (ctx, deps) => {
    const outbox = new SqliteDeliveryOutbox({
      agentName: ctx.agentName,
      clock: ctx.clock,
      db: ctx.db,
      deps,
      events: ctx.events,
      log: ctx.log,
      random: deps.random ?? Math.random,
    });

    return {
      api: outbox,
      rpc: createOutboxRpc(outbox),
      start: outbox.start,
      stop: outbox.stop,
    };
  },
  migrations: outboxMigrations,
  name: OUTBOX_NAMESPACE,
  scope: "agent",
};

/** What the Webhook Ingress module needs from the Deployment. */
export interface WebhookIngressModuleDeps extends WebhookIngressDeps {
  /** The `webhooks` block of `config.yaml`. The listener stays off unless `enabled` is true. */
  readonly config: WebhooksConfig | undefined;
}

/** The API of the Webhook Ingress module. */
export interface WebhookIngressModuleApi extends WebhookIngress {
  /**
   * True if `webhooks.enabled` is true. If it is false, the Deployment omits `FrontendContext.registerWebhookRoute`.
   */
  readonly enabled: boolean;
  /** The bound host and port while the listener runs, else `undefined`. */
  readonly address: () =>
    | { readonly host: string; readonly port: number }
    | undefined;
}

/**
 * The Webhook Ingress module of the Deployment (ADR 0010, ADR 0012). `start` opens the HTTP listener on
 * `webhooks.host` (default `127.0.0.1`) and `webhooks.port` (default `8788`) if `webhooks.enabled` is true. It has no
 * JSON-RPC handlers.
 */
export const webhookIngressModule: DeploymentModule<
  WebhookIngressModuleDeps,
  WebhookIngressModuleApi
> = {
  create: (ctx, deps) => {
    const ingress = new HttpWebhookIngress({
      agent: deps.agent,
      clock: ctx.clock,
      log: ctx.log,
      secrets: deps.secrets,
    });

    const enabled = deps.config?.enabled === true;

    return {
      api: {
        address: () => {
          const address = ingress.address();

          return address === undefined
            ? undefined
            : { host: address.address, port: address.port };
        },
        enabled,
        handle: ingress.handle,
        registerFrontendRoute: ingress.registerFrontendRoute,
      },
      rpc: {},
      start: async () => {
        if (enabled) {
          await ingress.listen(
            deps.config?.host ?? DEFAULT_WEBHOOK_HOST,
            deps.config?.port ?? DEFAULT_WEBHOOK_PORT
          );
        }
      },
      stop: ingress.close,
    };
  },
  name: "webhook_ingress",
  scope: "deployment",
};
