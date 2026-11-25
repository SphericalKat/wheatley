import type { DeliveryOutbox } from "../contracts/delivery-outbox.js";
import type { RpcHandlerMap } from "../contracts/module.js";
import type { TriggerRuntime } from "../contracts/trigger-runtime.js";

/**
 * The Operator JSON-RPC handlers for the Triggers of one Agent: `triggers.list`, `triggers.create`, `triggers.update`,
 * `triggers.delete`, and `triggers.fire`. The Operator manages every Trigger kind, including `webhook`.
 *
 * Errors: the handlers pass on the `SeamError` values of `TriggerRuntime`, for example `not_found` for an unknown
 * Trigger and `invalid_name` for an invalid cron expression. The router converts them.
 */
export const createTriggerRpc = (runtime: TriggerRuntime): RpcHandlerMap => ({
  "triggers.create": async ({ trigger }) => ({
    trigger: await runtime.create(trigger, "operator"),
  }),
  "triggers.delete": async ({ triggerId }) => ({
    deleted: await runtime.delete(triggerId, "operator"),
  }),
  "triggers.fire": async ({ triggerId }) => await runtime.fire(triggerId),
  "triggers.list": async () => ({ triggers: [...(await runtime.list())] }),
  "triggers.update": async ({ patch, triggerId }) => ({
    trigger: await runtime.update(triggerId, patch, "operator"),
  }),
});

/**
 * The Operator JSON-RPC handlers for the failed deliveries of one Agent: `deliveries.listFailed`, `deliveries.retry`,
 * and `deliveries.dismiss`. Retry and dismiss resolve `false` for an entry that is not `failed`.
 */
export const createOutboxRpc = (outbox: DeliveryOutbox): RpcHandlerMap => ({
  "deliveries.dismiss": async ({ deliveryId }) => ({
    dismissed: await outbox.dismiss(deliveryId),
  }),
  "deliveries.listFailed": async () => ({
    deliveries: [...(await outbox.listFailed())],
  }),
  "deliveries.retry": async ({ deliveryId }) => ({
    requeued: await outbox.retry(deliveryId),
  }),
});
