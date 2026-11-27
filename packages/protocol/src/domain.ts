import { Type } from "typebox";
import type { Static } from "typebox";

import {
  APPROVAL_REASON_MAX_LENGTH,
  CRON_EXPRESSION_MIN_LENGTH,
  DELIVERY_PREVIEW_MAX_LENGTH,
  DISPLAY_NAME_MAX_LENGTH,
  TOOL_INPUT_PREVIEW_MAX_LENGTH,
  TRIGGER_NAME_MAX_LENGTH,
} from "./limits.js";

/** An Agent name. It is the permanent Agent ID and its folder name under `agents/`. */
export const AgentNameSchema = Type.String({
  pattern: "^[a-z][a-z0-9-]{0,62}$",
});

export type AgentName = Static<typeof AgentNameSchema>;

/** A non-empty opaque ID. */
export const IdSchema = Type.String({ minLength: 1 });

export type Id = Static<typeof IdSchema>;

/** An ISO 8601 UTC timestamp, for example `2026-11-26T09:30:00.000Z`. */
export const TimestampSchema = Type.String({
  pattern: String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$`,
});

export type Timestamp = Static<typeof TimestampSchema>;

/** A duration such as `500ms`, `30s`, `15m`, `2h`, or `1d`. */
export const DurationSchema = Type.String({ pattern: "^[0-9]+(ms|s|m|h|d)$" });

export type Duration = Static<typeof DurationSchema>;

/** A count of zero or more. */
export const Count = Type.Integer({ minimum: 0 });

/** A secret name in `secrets.yaml` or the environment, never its value. */
export const SecretNameSchema = Type.String({
  pattern: "^[A-Za-z_][A-Za-z0-9_]{0,127}$",
});

export type SecretName = Static<typeof SecretNameSchema>;

/** The Supervisor state of an Agent. */
export const AgentStateSchema = Type.Union([
  Type.Literal("starting"),
  Type.Literal("running"),
  Type.Literal("degraded"),
  Type.Literal("stopped"),
]);

export type AgentState = Static<typeof AgentStateSchema>;

/** One Chat: a Frontend Binding and the platform Chat ID inside it. */
export const ChatKeySchema = Type.Object({
  bindingId: IdSchema,
  chatId: IdSchema,
});

export type ChatKey = Static<typeof ChatKeySchema>;

/** The state of a Plugin, MCP Server, or Frontend Binding inside an Agent. */
export const ExtensionStateSchema = Type.Union([
  Type.Literal("starting"),
  Type.Literal("ready"),
  Type.Literal("failed"),
  Type.Literal("disabled"),
  Type.Literal("stopped"),
]);

export type ExtensionState = Static<typeof ExtensionStateSchema>;

/** Load or connection status of one extension. */
export const ExtensionStatusSchema = Type.Object({
  error: Type.Optional(Type.String()),
  name: Type.String(),
  state: ExtensionStateSchema,
});

export type ExtensionStatus = Static<typeof ExtensionStatusSchema>;

/** Status of one Frontend Binding. */
export const BindingStatusSchema = Type.Object({
  error: Type.Optional(Type.String()),
  id: IdSchema,
  state: ExtensionStateSchema,
  type: Type.String(),
});

export type BindingStatus = Static<typeof BindingStatusSchema>;

/** Health of one Agent, as the Overview view shows it. */
export const AgentHealthSchema = Type.Object({
  activeRuns: Count,
  frontends: Type.Array(BindingStatusSchema),
  lastError: Type.Union([Type.String(), Type.Null()]),
  mcpServers: Type.Array(ExtensionStatusSchema),
  name: AgentNameSchema,
  pendingRestart: Type.Boolean(),
  plugins: Type.Array(ExtensionStatusSchema),
  /** Milliseconds until the next restart attempt, or `null` if no restart waits. */
  restartBackoffMs: Type.Union([Count, Type.Null()]),
  skillWarnings: Type.Array(Type.String()),
  state: AgentStateSchema,
});

export type AgentHealth = Static<typeof AgentHealthSchema>;

/** One model of a provider, for example `anthropic` and `claude-sonnet-5-5`. */
export const ModelRefSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  provider: Type.String({ minLength: 1 }),
});

export type ModelRef = Static<typeof ModelRefSchema>;

/** A model that a user can choose, with its display name. */
export const AvailableModelSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String(),
  provider: Type.String({ minLength: 1 }),
});

export type AvailableModel = Static<typeof AvailableModelSchema>;

/** Use of one Concurrency Gate key, which is one provider credential. */
export const GatePressureSchema = Type.Object({
  credential: Type.String(),
  inUse: Count,
  limit: Count,
  waiting: Count,
});

export type GatePressure = Static<typeof GatePressureSchema>;

/** Deployment health for the Overview view and `wheatley status`. */
export const DaemonStatusSchema = Type.Object({
  agents: Type.Array(AgentHealthSchema),
  concurrency: Type.Array(GatePressureSchema),
  protocolVersion: Type.Integer({ minimum: 1 }),
  startedAt: TimestampSchema,
  uptimeMs: Count,
  version: Type.String(),
});

export type DaemonStatus = Static<typeof DaemonStatusSchema>;

/** A Permission Policy action. */
export const PermissionActionSchema = Type.Union([
  Type.Literal("allow"),
  Type.Literal("ask"),
  Type.Literal("deny"),
]);

export type PermissionAction = Static<typeof PermissionActionSchema>;

/**
 * One Permission Policy rule. `tool` is a canonical Tool name with optional `*` wildcards, for example `shell`,
 * `notes:*`, `mcp:github:*`, or `mcp:context7:resolve-library-id`. Matching is case-sensitive, because MCP Tool names
 * can contain uppercase letters.
 */
export const PermissionRuleSchema = Type.Object(
  {
    action: PermissionActionSchema,
    tool: Type.String({
      pattern: String.raw`^[A-Za-z0-9_*.][A-Za-z0-9_*.:\-]*$`,
    }),
  },
  { additionalProperties: false }
);

export type PermissionRule = Static<typeof PermissionRuleSchema>;

/** A Sender or Operator decision on an Approval. */
export const ApprovalDecisionSchema = Type.Union([
  Type.Literal("allow_once"),
  Type.Literal("allow_conversation"),
  Type.Literal("allow_always"),
  Type.Literal("deny"),
]);

export type ApprovalDecision = Static<typeof ApprovalDecisionSchema>;

/** How an Approval ended. */
export const ApprovalOutcomeSchema = Type.Union([
  ApprovalDecisionSchema,
  Type.Literal("timeout"),
  Type.Literal("cancelled"),
]);

export type ApprovalOutcome = Static<typeof ApprovalOutcomeSchema>;

/** A decision with optional attribution and reason. */
export const ApprovalResolutionSchema = Type.Object(
  {
    decision: ApprovalDecisionSchema,
    reason: Type.Optional(
      Type.String({ maxLength: APPROVAL_REASON_MAX_LENGTH })
    ),
    resolvedBy: Type.Optional(
      Type.String({ maxLength: DISPLAY_NAME_MAX_LENGTH })
    ),
  },
  { additionalProperties: false }
);

export type ApprovalResolution = Static<typeof ApprovalResolutionSchema>;

/** An Approval that waits for a decision. */
export const PendingApprovalSchema = Type.Object({
  agent: AgentNameSchema,
  approvalId: IdSchema,
  /** The originating Chat, or `null` for a Run without a Chat. */
  chat: Type.Union([ChatKeySchema, Type.Null()]),
  conversationId: IdSchema,
  createdAt: TimestampSchema,
  expiresAt: Type.Union([TimestampSchema, Type.Null()]),
  /** Formatted Tool input, at most 500 characters, with secret values redacted. */
  inputPreview: Type.String({ maxLength: TOOL_INPUT_PREVIEW_MAX_LENGTH }),
  runId: IdSchema,
  toolName: Type.String(),
});

export type PendingApproval = Static<typeof PendingApprovalSchema>;

/** What started a Run. */
export const RunOriginSchema = Type.Union([
  Type.Object({
    bindingId: IdSchema,
    chatId: IdSchema,
    kind: Type.Literal("chat"),
  }),
  Type.Object({ kind: Type.Literal("trigger"), triggerId: IdSchema }),
  Type.Object({ job: Type.String(), kind: Type.Literal("maintenance") }),
]);

export type RunOrigin = Static<typeof RunOriginSchema>;

/** The state of a Run. */
export const RunStatusSchema = Type.Union([
  Type.Literal("running"),
  Type.Literal("waiting_approval"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("stopped"),
]);

export type RunStatus = Static<typeof RunStatusSchema>;

/** Token use and cost of a Run. */
export const RunUsageSchema = Type.Object({
  costUsd: Type.Optional(Type.Number({ minimum: 0 })),
  inputTokens: Count,
  outputTokens: Count,
});

export type RunUsage = Static<typeof RunUsageSchema>;

/** One Run. */
export const RunSummarySchema = Type.Object({
  agent: AgentNameSchema,
  conversationId: IdSchema,
  endedAt: Type.Union([TimestampSchema, Type.Null()]),
  error: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  origin: RunOriginSchema,
  runId: IdSchema,
  startedAt: TimestampSchema,
  status: RunStatusSchema,
  usage: Type.Optional(RunUsageSchema),
});

export type RunSummary = Static<typeof RunSummarySchema>;

/** One item of a Run timeline. */
export const RunTimelineItemSchema = Type.Union([
  Type.Object({
    at: TimestampSchema,
    kind: Type.Literal("user_message"),
    senderDisplayName: Type.Optional(Type.String()),
    text: Type.String(),
  }),
  Type.Object({
    at: TimestampSchema,
    kind: Type.Literal("assistant_text"),
    text: Type.String(),
  }),
  Type.Object({
    endedAt: Type.Union([TimestampSchema, Type.Null()]),
    inputPreview: Type.String(),
    isError: Type.Optional(Type.Boolean()),
    kind: Type.Literal("tool_call"),
    outputPreview: Type.Optional(Type.String()),
    startedAt: TimestampSchema,
    toolCallId: IdSchema,
    toolName: Type.String(),
  }),
  Type.Object({
    approvalId: IdSchema,
    at: TimestampSchema,
    decision: Type.Optional(ApprovalOutcomeSchema),
    kind: Type.Literal("approval"),
    toolName: Type.String(),
  }),
]);

export type RunTimelineItem = Static<typeof RunTimelineItemSchema>;

/** File metadata of an attachment. */
export const AttachmentInfoSchema = Type.Object({
  filename: Type.String(),
  mimeType: Type.String(),
  sizeBytes: Count,
});

export type AttachmentInfo = Static<typeof AttachmentInfoSchema>;

/** A file that a client uploads with `chat.send` or `chat.ask`. `data` is base64. */
export const AttachmentUploadSchema = Type.Object(
  {
    data: Type.String({ contentEncoding: "base64" }),
    filename: Type.String({ minLength: 1 }),
    mimeType: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);

export type AttachmentUpload = Static<typeof AttachmentUploadSchema>;

/** One message in the CLI and dashboard Chat. */
export const ChatMessageSchema = Type.Object({
  at: TimestampSchema,
  attachments: Type.Optional(Type.Array(AttachmentInfoSchema)),
  messageId: IdSchema,
  role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
  runId: Type.Optional(IdSchema),
  senderDisplayName: Type.Optional(Type.String()),
  source: Type.Optional(
    Type.Union([
      Type.Literal("reply"),
      Type.Literal("command"),
      Type.Literal("trigger"),
    ])
  ),
  text: Type.String(),
});

export type ChatMessage = Static<typeof ChatMessageSchema>;

/** The built-in Chat commands, without the leading slash. */
export const CommandNameSchema = Type.Union([
  Type.Literal("new"),
  Type.Literal("model"),
  Type.Literal("compact"),
  Type.Literal("stop"),
  Type.Literal("goal"),
  Type.Literal("status"),
  Type.Literal("restart"),
]);

export type CommandName = Static<typeof CommandNameSchema>;

/** How a TriggerSchema maps firings to Conversations. */
export const ConversationModeSchema = Type.Union([
  Type.Literal("per_firing"),
  Type.Literal("shared"),
]);

export type ConversationMode = Static<typeof ConversationModeSchema>;

/** The schedule part of a TriggerSchema. */
export const TriggerScheduleSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("cron"),
      /** A 5-field cron expression. */
      schedule: Type.String({ minLength: CRON_EXPRESSION_MIN_LENGTH }),
      /** An IANA time zone, for example `Europe/Berlin`. */
      timezone: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    { at: TimestampSchema, kind: Type.Literal("once") },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      kind: Type.Literal("webhook"),
      /** The name of the Bearer token secret in `secrets.yaml`. */
      tokenSecret: SecretNameSchema,
    },
    { additionalProperties: false }
  ),
]);

export type TriggerSchedule = Static<typeof TriggerScheduleSchema>;

/** Fields of a new TriggerSchema. */
export const TriggerInputSchema = Type.Object(
  {
    conversationMode: Type.Optional(ConversationModeSchema),
    name: Type.String({ maxLength: TRIGGER_NAME_MAX_LENGTH, minLength: 1 }),
    paused: Type.Optional(Type.Boolean()),
    /** The instruction for each firing. A webhook firing appends the request body. */
    prompt: Type.String({ minLength: 1 }),
    schedule: TriggerScheduleSchema,
    target: ChatKeySchema,
  },
  { additionalProperties: false }
);

export type TriggerInput = Static<typeof TriggerInputSchema>;

/** Fields to change on a TriggerSchema. Absent fields stay the same. */
export const TriggerPatchSchema = Type.Object(
  {
    conversationMode: Type.Optional(ConversationModeSchema),
    name: Type.Optional(
      Type.String({ maxLength: TRIGGER_NAME_MAX_LENGTH, minLength: 1 })
    ),
    paused: Type.Optional(Type.Boolean()),
    prompt: Type.Optional(Type.String({ minLength: 1 })),
    schedule: Type.Optional(TriggerScheduleSchema),
    target: Type.Optional(ChatKeySchema),
  },
  { additionalProperties: false }
);

export type TriggerPatch = Static<typeof TriggerPatchSchema>;

/** A stored TriggerSchema. */
export const TriggerSchema = Type.Object({
  conversationMode: ConversationModeSchema,
  createdAt: TimestampSchema,
  /** Agents create `cron` and `once` Triggers through Tools. Only the Operator creates `webhook` Triggers. */
  createdBy: Type.Union([Type.Literal("agent"), Type.Literal("operator")]),
  id: IdSchema,
  lastFiredAt: Type.Union([TimestampSchema, Type.Null()]),
  name: Type.String(),
  nextFireAt: Type.Union([TimestampSchema, Type.Null()]),
  paused: Type.Boolean(),
  prompt: Type.String(),
  schedule: TriggerScheduleSchema,
  target: ChatKeySchema,
});

export type Trigger = Static<typeof TriggerSchema>;

/** The kinds of Frontend delivery. */
export const DeliveryKindSchema = Type.Union([
  Type.Literal("message"),
  Type.Literal("approval_requested"),
  Type.Literal("approval_resolved"),
]);

export type DeliveryKind = Static<typeof DeliveryKindSchema>;

/** An outbox entry that failed. */
export const FailedDeliverySchema = Type.Object({
  agent: AgentNameSchema,
  attempts: Count,
  bindingId: IdSchema,
  chatId: IdSchema,
  createdAt: TimestampSchema,
  deliveryId: IdSchema,
  failedAt: TimestampSchema,
  kind: DeliveryKindSchema,
  lastError: Type.String(),
  permanent: Type.Boolean(),
  preview: Type.String({ maxLength: DELIVERY_PREVIEW_MAX_LENGTH }),
});

export type FailedDelivery = Static<typeof FailedDeliverySchema>;

/** A Memory file name: `MEMORY` for `MEMORY.md`, otherwise the slug of `<slug>.md`. */
export const MemoryNameSchema = Type.String({
  pattern: "^(MEMORY|[a-z0-9][a-z0-9-]{0,63})$",
});

export type MemoryName = Static<typeof MemoryNameSchema>;

/** Metadata of one Memory file. */
export const MemoryFileSchema = Type.Object({
  chars: Count,
  name: MemoryNameSchema,
  updatedAt: TimestampSchema,
});

export type MemoryFile = Static<typeof MemoryFileSchema>;

/** The `MEMORY.md` character budget. */
export const MemoryBudgetSchema = Type.Object({
  maxChars: Count,
  usedChars: Count,
});

export type MemoryBudget = Static<typeof MemoryBudgetSchema>;

/** Where a Memory search looks. */
export const MemorySearchScopeSchema = Type.Union([
  Type.Literal("memory"),
  Type.Literal("conversations"),
  Type.Literal("all"),
]);

export type MemorySearchScope = Static<typeof MemorySearchScopeSchema>;

/** One Memory search result. */
export const MemorySearchHitSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("memory"),
    name: MemoryNameSchema,
    score: Type.Number(),
    snippet: Type.String(),
  }),
  Type.Object({
    at: TimestampSchema,
    conversationId: IdSchema,
    kind: Type.Literal("conversation"),
    role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
    score: Type.Number(),
    snippet: Type.String(),
  }),
]);

export type MemorySearchHit = Static<typeof MemorySearchHitSchema>;

/** One run of the Memory consolidation job. */
export const ConsolidationLogEntrySchema = Type.Object({
  endedAt: Type.Union([TimestampSchema, Type.Null()]),
  error: Type.Optional(Type.String()),
  id: IdSchema,
  runId: Type.Optional(IdSchema),
  startedAt: TimestampSchema,
  status: Type.Union([
    Type.Literal("running"),
    Type.Literal("completed"),
    Type.Literal("failed"),
  ]),
  summary: Type.Optional(Type.String()),
});

export type ConsolidationLogEntry = Static<typeof ConsolidationLogEntrySchema>;

/** Where a secret value comes from. */
export const SecretSourceSchema = Type.Union([
  Type.Literal("file"),
  Type.Literal("env"),
  Type.Literal("both"),
]);

export type SecretSource = Static<typeof SecretSourceSchema>;

/** A secret and the config entries that refer to it. */
export const SecretInfoSchema = Type.Object({
  name: SecretNameSchema,
  references: Type.Array(
    Type.Object({
      agent: Type.Optional(AgentNameSchema),
      id: Type.String(),
      kind: Type.Union([
        Type.Literal("provider"),
        Type.Literal("frontend"),
        Type.Literal("mcp"),
        Type.Literal("plugin"),
        Type.Literal("trigger"),
      ]),
    })
  ),
  source: SecretSourceSchema,
});

export type SecretInfo = Static<typeof SecretInfoSchema>;

/** A diagnostic log level. */
export const LogLevelSchema = Type.Union([
  Type.Literal("debug"),
  Type.Literal("info"),
  Type.Literal("warn"),
  Type.Literal("error"),
]);

export type LogLevel = Static<typeof LogLevelSchema>;

/** One diagnostic log record. Records never contain secret values. */
export const LogRecordSchema = Type.Object({
  agent: Type.Optional(AgentNameSchema),
  at: TimestampSchema,
  fields: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  level: LogLevelSchema,
  message: Type.String(),
  module: Type.String(),
  /** Increases by one for each record in a daemon process. */
  seq: Count,
});

export type LogRecord = Static<typeof LogRecordSchema>;

/** A config change that waits for a restart to take effect. */
export const PendingRestartSchema = Type.Union([
  Type.Object({ agent: AgentNameSchema, kind: Type.Literal("agent") }),
  Type.Object({
    agent: AgentNameSchema,
    bindingId: IdSchema,
    kind: Type.Literal("binding"),
  }),
  Type.Object({ kind: Type.Literal("daemon"), reason: Type.String() }),
]);

export type PendingRestart = Static<typeof PendingRestartSchema>;

/** One problem in a config file. `path` is a JSON Pointer, for example `/agents/home/model`. */
export const ConfigIssueSchema = Type.Object({
  message: Type.String(),
  path: Type.String(),
});

export type ConfigIssue = Static<typeof ConfigIssueSchema>;

/** Where a Tool comes from. */
export const ToolSourceSchema = Type.Union([
  Type.Literal("builtin"),
  Type.Literal("plugin"),
  Type.Literal("mcp"),
]);

export type ToolSource = Static<typeof ToolSourceSchema>;

/** A Tool that an Agent offers, with its effective Permission Policy action. */
export const ToolInfoSchema = Type.Object({
  action: PermissionActionSchema,
  description: Type.String(),
  name: Type.String(),
  source: ToolSourceSchema,
});

export type ToolInfo = Static<typeof ToolInfoSchema>;

/** A discovered Skill. */
export const SkillInfoSchema = Type.Object({
  description: Type.String(),
  name: Type.String(),
  origin: Type.Union([Type.Literal("shared"), Type.Literal("agent")]),
  path: Type.String(),
});

export type SkillInfo = Static<typeof SkillInfoSchema>;
