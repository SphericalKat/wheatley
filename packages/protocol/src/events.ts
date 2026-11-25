import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import {
  AgentNameSchema,
  AgentStateSchema,
  ApprovalOutcomeSchema,
  ChatMessageSchema,
  FailedDeliverySchema,
  IdSchema,
  LogRecordSchema,
  MemoryNameSchema,
  PendingApprovalSchema,
  PendingRestartSchema,
  RunSummarySchema,
  TriggerSchema,
} from "./domain.js";

/**
 * Every v1 live event that the daemon sends as a JSON-RPC notification. The notification `method` is the event name
 * and `params` is the payload (ADR 0003, ADR 0005).
 *
 * On one connection, the response to a request always arrives before the events that the request caused.
 */
export const events = {
  "agent.status": Type.Object({
    agent: AgentNameSchema,
    error: Type.Optional(Type.String()),
    state: AgentStateSchema,
  }),
  /** Every client receives it. The first `approvals.decide` call wins. */
  "approval.requested": Type.Object({
    agent: AgentNameSchema,
    approval: PendingApprovalSchema,
  }),
  "approval.resolved": Type.Object({
    agent: AgentNameSchema,
    approvalId: IdSchema,
    decision: ApprovalOutcomeSchema,
    reason: Type.Optional(Type.String()),
    resolvedBy: Type.Optional(Type.String()),
  }),
  /** A message in the Agent's CLI Chat, from any client or the Agent. */
  "chat.message": Type.Object({
    agent: AgentNameSchema,
    message: ChatMessageSchema,
  }),
  "config.changed": Type.Object({
    pendingRestart: Type.Array(PendingRestartSchema),
    revision: Type.String(),
  }),
  /** A failed outbox entry left the Inbox. */
  "delivery.cleared": Type.Object({
    agent: AgentNameSchema,
    deliveryId: IdSchema,
    reason: Type.Union([
      Type.Literal("retried"),
      Type.Literal("dismissed"),
      Type.Literal("delivered"),
    ]),
  }),
  "delivery.failed": Type.Object({
    agent: AgentNameSchema,
    delivery: FailedDeliverySchema,
  }),
  "log.record": Type.Object({ record: LogRecordSchema }),
  "memory.changed": Type.Object({
    agent: AgentNameSchema,
    change: Type.Union([
      Type.Literal("written"),
      Type.Literal("deleted"),
      Type.Literal("reindexed"),
    ]),
    name: Type.Optional(MemoryNameSchema),
  }),
  /** Streamed assistant text of a running Run. */
  "run.delta": Type.Object({
    agent: AgentNameSchema,
    delta: Type.String(),
    runId: IdSchema,
  }),
  "run.finished": Type.Object({
    agent: AgentNameSchema,
    run: RunSummarySchema,
  }),
  "run.started": Type.Object({ agent: AgentNameSchema, run: RunSummarySchema }),
  "run.toolFinished": Type.Object({
    agent: AgentNameSchema,
    isError: Type.Boolean(),
    outputPreview: Type.String({ maxLength: 500 }),
    runId: IdSchema,
    toolCallId: IdSchema,
    toolName: Type.String(),
  }),
  "run.toolStarted": Type.Object({
    agent: AgentNameSchema,
    inputPreview: Type.String({ maxLength: 500 }),
    runId: IdSchema,
    toolCallId: IdSchema,
    toolName: Type.String(),
  }),
  "trigger.changed": Type.Object({
    agent: AgentNameSchema,
    change: Type.Union([
      Type.Literal("created"),
      Type.Literal("updated"),
      Type.Literal("deleted"),
      Type.Literal("fired"),
    ]),
    trigger: Type.Optional(TriggerSchema),
    triggerId: IdSchema,
  }),
} as const;

/** The name of a v1 event. */
export type EventName = keyof typeof events;

/** The payload of event `E`. */
export type EventPayload<E extends EventName> = Static<(typeof events)[E]>;

/** Returns true if `name` is a v1 event. */
export const isEventName = (name: string): name is EventName =>
  Object.hasOwn(events, name);

/** The names of all v1 events. */
export const EVENT_NAMES: readonly EventName[] =
  Object.keys(events).filter(isEventName);

/** An event topic: the part of an event name before the dot. `events.subscribe` filters by topic. */
export const EventTopicSchema = Type.Union([
  Type.Literal("agent"),
  Type.Literal("approval"),
  Type.Literal("chat"),
  Type.Literal("config"),
  Type.Literal("delivery"),
  Type.Literal("log"),
  Type.Literal("memory"),
  Type.Literal("run"),
  Type.Literal("trigger"),
]);

export type EventTopic = Static<typeof EventTopicSchema>;

/** Returns the topic of event `name`. */
export const eventTopic = (name: EventName): EventTopic => {
  const topic = name.slice(0, name.indexOf("."));

  if (!Value.Check(EventTopicSchema, topic)) {
    throw new Error(`Event ${name} has no known topic`);
  }

  return topic;
};
