import { Type } from "typebox";
import type { Static, TProperties, TSchema } from "typebox";

import { AgentConfigSchema, DeploymentConfigSchema } from "./config.js";
import {
  AgentHealthSchema,
  AgentNameSchema,
  AgentStateSchema,
  ApprovalResolutionSchema,
  AttachmentUploadSchema,
  AvailableModelSchema,
  BindingStatusSchema,
  ChatMessageSchema,
  CommandNameSchema,
  ConfigIssueSchema,
  ConsolidationLogEntrySchema,
  Count,
  DaemonStatusSchema,
  ExtensionStatusSchema,
  FailedDeliverySchema,
  IdSchema,
  LogLevelSchema,
  LogRecordSchema,
  MemoryBudgetSchema,
  MemoryFileSchema,
  MemoryNameSchema,
  MemorySearchHitSchema,
  MemorySearchScopeSchema,
  ModelRefSchema,
  PendingApprovalSchema,
  PendingRestartSchema,
  RunSummarySchema,
  RunTimelineItemSchema,
  SecretInfoSchema,
  SecretNameSchema,
  SecretSourceSchema,
  SkillInfoSchema,
  ToolInfoSchema,
  TriggerSchema,
  TriggerInputSchema,
  TriggerPatchSchema,
} from "./domain.js";
import { EventTopicSchema } from "./events.js";
import { DISPLAY_NAME_MAX_LENGTH } from "./limits.js";

/** The protocol version of this package. The CLI and dashboard compare it in `system.hello`. */
export const PROTOCOL_VERSION = 1;

const MAX_PAGE = 500;

/** A params object that rejects unknown fields, so typos fail with `invalid_params`. */
const params = <Properties extends TProperties>(properties: Properties) =>
  Type.Object(properties, { additionalProperties: false });

/** Defines one method: its params schema and its result schema. */
const method = <Params extends TSchema, Result extends TSchema>(
  paramsSchema: Params,
  resultSchema: Result
) => ({ params: paramsSchema, result: resultSchema });

const agentParams = params({ agent: AgentNameSchema });
const limit = Type.Optional(Type.Integer({ maximum: MAX_PAGE, minimum: 1 }));
const revision = Type.String({ minLength: 1 });

/**
 * Every v1 JSON-RPC method that the CLI and dashboard call (ADR 0005).
 *
 * A method with an `agent` param acts on that Agent only. Within protocol version 1, methods and result fields are
 * only added, never removed or changed.
 */
export const methods = {
  "agents.create": method(
    params({
      agent: AgentNameSchema,
      config: AgentConfigSchema,
      expectedRevision: revision,
    }),
    Type.Object({ revision })
  ),
  "agents.delete": method(
    params({
      agent: AgentNameSchema,
      /** What happens to `agents/<name>/`: keep it, move it to an archive folder, or delete it. */
      data: Type.Union([
        Type.Literal("keep"),
        Type.Literal("archive"),
        Type.Literal("delete"),
      ]),
      expectedRevision: revision,
    }),
    Type.Object({ revision })
  ),
  "agents.get": method(agentParams, AgentHealthSchema),
  "agents.list": method(
    params({}),
    Type.Object({ agents: Type.Array(AgentHealthSchema) })
  ),
  "agents.rename": method(
    params({
      agent: AgentNameSchema,
      expectedRevision: revision,
      newName: AgentNameSchema,
    }),
    Type.Object({ revision })
  ),
  "agents.restart": method(
    agentParams,
    Type.Object({ state: AgentStateSchema })
  ),
  "agents.start": method(agentParams, Type.Object({ state: AgentStateSchema })),
  "agents.stop": method(agentParams, Type.Object({ state: AgentStateSchema })),

  "approvals.decide": method(
    params({
      agent: AgentNameSchema,
      approvalId: IdSchema,
      resolution: ApprovalResolutionSchema,
    }),
    /** `accepted` is false if another decision won or the Approval ended. */
    Type.Object({ accepted: Type.Boolean() })
  ),
  "approvals.list": method(
    params({ agent: Type.Optional(AgentNameSchema) }),
    Type.Object({ approvals: Type.Array(PendingApprovalSchema) })
  ),

  /**
   * Sends a one-shot prompt for `wheatley ask`. Resolves once the Agent stored the message and its Run. The Run uses
   * the CLI Chat's current Conversation (`cli` binding, Chat `default`), as `chat.send` does, so the dashboard shows it.
   *
   * `interactive: false` (for a CLI without a TTY) makes the gate deny every `ask` Tool without a prompt (ADR 0011).
   * The client matches the reply by `runId`: the `chat.message` event with that `runId`, then `run.finished`.
   */
  "chat.ask": method(
    params({
      agent: AgentNameSchema,
      attachments: Type.Optional(Type.Array(AttachmentUploadSchema)),
      interactive: Type.Boolean(),
      senderDisplayName: Type.Optional(
        Type.String({ maxLength: DISPLAY_NAME_MAX_LENGTH })
      ),
      text: Type.String({ minLength: 1 }),
    }),
    Type.Object({
      conversationId: IdSchema,
      messageId: IdSchema,
      runId: IdSchema,
    })
  ),
  "chat.command": method(
    params({
      agent: AgentNameSchema,
      args: Type.Optional(Type.String()),
      name: CommandNameSchema,
    }),
    Type.Object({ accepted: Type.Boolean() })
  ),
  "chat.history": method(
    params({ agent: AgentNameSchema, before: Type.Optional(IdSchema), limit }),
    Type.Object({
      conversationId: IdSchema,
      hasMore: Type.Boolean(),
      messages: Type.Array(ChatMessageSchema),
    })
  ),
  /** Sends a message to the Agent's CLI Chat (`cli` binding, Chat `default`), which the dashboard shares. */
  "chat.send": method(
    params({
      agent: AgentNameSchema,
      attachments: Type.Optional(Type.Array(AttachmentUploadSchema)),
      senderDisplayName: Type.Optional(
        Type.String({ maxLength: DISPLAY_NAME_MAX_LENGTH })
      ),
      text: Type.String(),
    }),
    Type.Object({ messageId: IdSchema })
  ),

  "config.get": method(
    params({}),
    Type.Object({
      config: DeploymentConfigSchema,
      pendingRestart: Type.Array(PendingRestartSchema),
      raw: Type.String(),
      revision,
    })
  ),
  /** Saves raw YAML or a structured config. The Config Store keeps YAML comments in both cases (ADR 0004). */
  "config.save": method(
    Type.Union([
      params({
        expectedRevision: revision,
        raw: Type.String(),
        restart: Type.Optional(
          Type.Union([Type.Literal("none"), Type.Literal("affected")])
        ),
      }),
      params({
        config: DeploymentConfigSchema,
        expectedRevision: revision,
        restart: Type.Optional(
          Type.Union([Type.Literal("none"), Type.Literal("affected")])
        ),
      }),
    ]),
    Type.Object({ pendingRestart: Type.Array(PendingRestartSchema), revision })
  ),
  "config.validate": method(
    params({ raw: Type.String() }),
    Type.Object({
      issues: Type.Array(ConfigIssueSchema),
      valid: Type.Boolean(),
    })
  ),

  "deliveries.dismiss": method(
    params({ agent: AgentNameSchema, deliveryId: IdSchema }),
    Type.Object({ dismissed: Type.Boolean() })
  ),
  "deliveries.listFailed": method(
    params({ agent: Type.Optional(AgentNameSchema) }),
    Type.Object({ deliveries: Type.Array(FailedDeliverySchema) })
  ),
  "deliveries.retry": method(
    params({ agent: AgentNameSchema, deliveryId: IdSchema }),
    Type.Object({ requeued: Type.Boolean() })
  ),

  "events.subscribe": method(
    params({
      /** Omitted: the events of every Agent. */
      agents: Type.Optional(Type.Array(AgentNameSchema)),
      /** Omitted: every topic. */
      topics: Type.Optional(Type.Array(EventTopicSchema)),
    }),
    Type.Object({ subscriptionId: IdSchema })
  ),
  "events.unsubscribe": method(
    params({ subscriptionId: IdSchema }),
    Type.Object({ removed: Type.Boolean() })
  ),

  "extensions.list": method(
    agentParams,
    Type.Object({
      frontends: Type.Array(BindingStatusSchema),
      mcpServers: Type.Array(ExtensionStatusSchema),
      plugins: Type.Array(ExtensionStatusSchema),
      skills: Type.Array(SkillInfoSchema),
      tools: Type.Array(ToolInfoSchema),
    })
  ),

  "logs.tail": method(
    params({
      agent: Type.Optional(AgentNameSchema),
      level: Type.Optional(LogLevelSchema),
      limit,
      module: Type.Optional(Type.String()),
    }),
    Type.Object({ records: Type.Array(LogRecordSchema) })
  ),

  "memory.consolidate": method(agentParams, Type.Object({ runId: IdSchema })),
  "memory.consolidationLog": method(
    params({ agent: AgentNameSchema, limit }),
    Type.Object({ entries: Type.Array(ConsolidationLogEntrySchema) })
  ),
  "memory.delete": method(
    params({ agent: AgentNameSchema, name: MemoryNameSchema }),
    Type.Object({ deleted: Type.Boolean() })
  ),
  "memory.list": method(
    agentParams,
    Type.Object({
      budget: MemoryBudgetSchema,
      files: Type.Array(MemoryFileSchema),
    })
  ),
  "memory.purgeConversation": method(
    params({ agent: AgentNameSchema, conversationId: IdSchema }),
    Type.Object({ purgedMessages: Count })
  ),
  "memory.read": method(
    params({ agent: AgentNameSchema, name: MemoryNameSchema }),
    Type.Object({ content: Type.String(), name: MemoryNameSchema })
  ),
  "memory.reindex": method(agentParams, Type.Object({ files: Count })),
  "memory.search": method(
    params({
      agent: AgentNameSchema,
      limit,
      query: Type.String({ minLength: 1 }),
      scope: Type.Optional(MemorySearchScopeSchema),
    }),
    Type.Object({ hits: Type.Array(MemorySearchHitSchema) })
  ),
  /** Rejects with `memory_budget_exceeded` if a `MEMORY.md` write exceeds the character cap. */
  "memory.write": method(
    params({
      agent: AgentNameSchema,
      content: Type.String(),
      mode: Type.Optional(
        Type.Union([Type.Literal("replace"), Type.Literal("append")])
      ),
      name: MemoryNameSchema,
    }),
    Type.Object({ file: MemoryFileSchema })
  ),

  /**
   * Lists the chat models of every provider with a configured credential, sorted by provider, then by model ID. With a
   * running `agent`, `current` is the model of its CLI Chat Conversation.
   */
  "models.list": method(
    params({ agent: Type.Optional(AgentNameSchema) }),
    Type.Object({
      current: Type.Optional(ModelRefSchema),
      models: Type.Array(AvailableModelSchema),
    })
  ),

  "runs.get": method(
    params({ agent: AgentNameSchema, runId: IdSchema }),
    Type.Object({
      run: RunSummarySchema,
      timeline: Type.Array(RunTimelineItemSchema),
    })
  ),
  "runs.list": method(
    params({
      agent: Type.Optional(AgentNameSchema),
      before: Type.Optional(IdSchema),
      limit,
      status: Type.Optional(
        Type.Union([Type.Literal("active"), Type.Literal("all")])
      ),
    }),
    Type.Object({ hasMore: Type.Boolean(), runs: Type.Array(RunSummarySchema) })
  ),
  "runs.stop": method(
    params({ agent: AgentNameSchema, runId: IdSchema }),
    Type.Object({ stopped: Type.Boolean() })
  ),

  "secrets.delete": method(
    params({ name: SecretNameSchema }),
    Type.Object({ deleted: Type.Boolean() })
  ),
  "secrets.list": method(
    params({}),
    Type.Object({ secrets: Type.Array(SecretInfoSchema) })
  ),
  /** Returns one plaintext secret value. Wheatley never logs it. */
  "secrets.reveal": method(
    params({ name: SecretNameSchema }),
    Type.Object({ value: Type.String() })
  ),
  /** Adds or rotates a secret in `secrets.yaml`. */
  "secrets.set": method(
    params({ name: SecretNameSchema, value: Type.String({ minLength: 1 }) }),
    Type.Object({ source: SecretSourceSchema })
  ),

  /** The first request of every connection. Fails with `protocol_mismatch` for another protocol version. */
  "system.hello": method(
    params({
      client: Type.Object({ name: Type.String(), version: Type.String() }),
      protocolVersion: Type.Integer({ minimum: 1 }),
    }),
    Type.Object({
      protocolVersion: Type.Integer({ minimum: 1 }),
      wheatleyVersion: Type.String(),
    })
  ),
  "system.status": method(params({}), DaemonStatusSchema),

  "triggers.create": method(
    params({ agent: AgentNameSchema, trigger: TriggerInputSchema }),
    Type.Object({ trigger: TriggerSchema })
  ),
  "triggers.delete": method(
    params({ agent: AgentNameSchema, triggerId: IdSchema }),
    Type.Object({ deleted: Type.Boolean() })
  ),
  /** Fires a TriggerSchema now, outside its schedule. */
  "triggers.fire": method(
    params({ agent: AgentNameSchema, triggerId: IdSchema }),
    Type.Object({ runId: IdSchema })
  ),
  "triggers.list": method(
    agentParams,
    Type.Object({ triggers: Type.Array(TriggerSchema) })
  ),
  "triggers.update": method(
    params({
      agent: AgentNameSchema,
      patch: TriggerPatchSchema,
      triggerId: IdSchema,
    }),
    Type.Object({ trigger: TriggerSchema })
  ),
} as const;

/** The name of a v1 method. */
export type MethodName = keyof typeof methods;

/** The params of method `M`. */
export type MethodParams<M extends MethodName> = Static<
  (typeof methods)[M]["params"]
>;

/** The result of method `M`. */
export type MethodResult<M extends MethodName> = Static<
  (typeof methods)[M]["result"]
>;

/** Returns true if `name` is a v1 method. */
export const isMethodName = (name: string): name is MethodName =>
  Object.hasOwn(methods, name);

/** The names of all v1 methods. */
export const METHOD_NAMES: readonly MethodName[] =
  Object.keys(methods).filter(isMethodName);
