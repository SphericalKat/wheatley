import type { CommandName, CommandSpec } from "./commands.js";
import type { JsonValue } from "./json.js";
import type { Logger, SecretReader } from "./logger.js";
import type { SchemaInput } from "./schema.js";

/**
 * A file sent to or from a Chat.
 *
 * Inbound files arrive staged on disk (`kind: "file"`). Outbound files can carry bytes or a staged path. Wheatley
 * rejects files larger than `FrontendContext.maxAttachmentBytes`.
 */
export type Attachment =
  | {
      readonly kind: "bytes";
      readonly filename: string;
      readonly mimeType: string;
      readonly data: Uint8Array;
    }
  | {
      readonly kind: "file";
      readonly filename: string;
      readonly mimeType: string;
      readonly path: string;
      readonly sizeBytes: number;
    };

/** A Sender's decision on an Approval (ADR 0011). */
export type ApprovalDecision =
  | "allow_once"
  | "allow_conversation"
  | "allow_always"
  | "deny";

/** How an Approval ended: a decision, the timeout, or `/stop`. */
export type ApprovalOutcome = ApprovalDecision | "timeout" | "cancelled";

/** A decision on an Approval, from a Chat or from the Operator. */
export interface ApprovalResolution {
  readonly decision: ApprovalDecision;
  /** Display name of whoever decided, for attribution only. */
  readonly resolvedBy?: string;
  /** Optional reason for `deny`. Wheatley shows it to the model. */
  readonly reason?: string;
}

/** Where an outbound `message` comes from. */
export type MessageSource = "reply" | "command" | "trigger";

/** One model of a provider, for example `anthropic` and `claude-sonnet-5-5`. */
export interface ModelRef {
  readonly provider: string;
  readonly id: string;
}

/** A model that a Sender can choose, with its display name. */
export interface AvailableModel extends ModelRef {
  readonly name: string;
}

/**
 * The models of a `/model` reply without an argument. Native chat Frontends can render it as a platform picker.
 *
 * `models` is sorted by provider, then by model ID. A selection calls `FrontendSink.command` with name `model` and
 * args `<provider>/<id>`.
 */
export interface ModelPicker {
  /** The model of the Chat's current Conversation, if known. */
  readonly current?: ModelRef;
  /** The models of every provider with a configured credential. Empty if no provider has one. */
  readonly models: readonly AvailableModel[];
}

/** A final Agent message for a Chat. */
export interface MessageDelivery {
  readonly kind: "message";
  /** The outbox ID. It stays the same across retries, so adapters can drop duplicates. */
  readonly messageId: string;
  readonly chatId: string;
  /** Markdown. The Frontend Binding converts it to the platform format and splits it into chunks. */
  readonly text: string;
  readonly attachments?: readonly Attachment[];
  readonly source: MessageSource;
  /** The Run that produced the reply. Streaming adapters use it to finalize their draft instead of a second message. */
  readonly runId?: string;
  /** Present on the reply to `/model` without an argument. `text` holds the same list as Markdown. */
  readonly modelPicker?: ModelPicker;
}

/** A tool call that waits for an Approval in this Chat. */
export interface ApprovalRequestedDelivery {
  readonly kind: "approval_requested";
  readonly messageId: string;
  readonly chatId: string;
  readonly approvalId: string;
  /** The canonical Tool name, for example `shell`, `notes:add`, or `mcp:github:create_issue`. */
  readonly toolName: string;
  /** Formatted Tool input, at most 500 characters, with secret values redacted. */
  readonly inputPreview: string;
  /** ISO 8601 timestamp, or `null` if the Approval never times out. */
  readonly expiresAt: string | null;
  readonly runId: string;
}

/** An Approval ended. Adapters edit or disable the prompt that they showed for `approval_requested`. */
export interface ApprovalResolvedDelivery {
  readonly kind: "approval_resolved";
  readonly messageId: string;
  readonly chatId: string;
  readonly approvalId: string;
  readonly decision: ApprovalOutcome;
  readonly resolvedBy?: string;
  readonly reason?: string;
}

/** Durable outbound work for a Frontend Binding, delivered at least once through the Agent outbox (ADR 0007). */
export type Delivery =
  | MessageDelivery
  | ApprovalRequestedDelivery
  | ApprovalResolvedDelivery;

/** The kinds of `Delivery`. */
export type DeliveryKind = Delivery["kind"];

/**
 * Ephemeral live progress of a Run in a Chat. Wheatley never stores or retries these events.
 *
 * Adapters show a typing indicator between `run_started` and `run_finished` and can stream `text_delta` into a
 * draft that the final `message` delivery with the same `runId` replaces.
 */
export type RunEvent =
  | {
      readonly kind: "run_started";
      readonly runId: string;
      readonly chatId: string;
    }
  | {
      readonly kind: "text_delta";
      readonly runId: string;
      readonly chatId: string;
      readonly delta: string;
    }
  | {
      readonly kind: "tool_started";
      readonly runId: string;
      readonly chatId: string;
      readonly toolCallId: string;
      readonly toolName: string;
    }
  | {
      readonly kind: "tool_finished";
      readonly runId: string;
      readonly chatId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly isError: boolean;
    }
  | {
      readonly kind: "run_finished";
      readonly runId: string;
      readonly chatId: string;
      readonly status: "completed" | "failed" | "stopped";
    };

/** A user message from a Chat. */
export interface InboundMessage {
  /** The Chat ID, which encodes thread structure, for example `<channel_id>:<thread_ts>` (ADR 0012). */
  readonly chatId: string;
  readonly text: string;
  /** The platform display name, for attribution only (ADR 0002). */
  readonly senderDisplayName?: string;
  readonly attachments?: readonly Attachment[];
}

/** A built-in command from a Chat, parsed from text or mapped from a native platform command. */
export interface InboundCommand {
  readonly chatId: string;
  readonly name: CommandName;
  readonly args?: string;
  readonly senderDisplayName?: string;
}

/** A Sender's decision on an Approval, from a Chat. */
export interface InboundDecision {
  /** The Chat where the Sender decided. */
  readonly chatId: string;
  readonly approvalId: string;
  readonly resolution: ApprovalResolution;
}

/** Inbound side of a Frontend Binding, provided by the Agent. */
export interface FrontendSink {
  /** The built-in command specs, for native command menus. */
  readonly commands: readonly CommandSpec[];
  /**
   * Hands a user message to the Agent. Resolves once the Agent stores it.
   *
   * Call it only for allowed Chats: the adapter enforces `allowedChatIds` before it calls the sink.
   */
  readonly send: (message: InboundMessage) => Promise<void>;
  /** Hands a built-in command to the Agent. Resolves once the Agent accepts it. */
  readonly command: (command: InboundCommand) => Promise<void>;
  /**
   * Submits a decision on an Approval from a Chat of this binding. Resolves `true` if this decision won, or `false` if
   * the Approval already ended, does not exist, or belongs to another Chat (ADR 0002: only a Sender in the originating
   * Chat can decide). The first decision from any surface wins (ADR 0005).
   */
  readonly decide: (decision: InboundDecision) => Promise<boolean>;
}

/** An HTTP request that the Webhook Ingress forwards to a Frontend route. */
export interface WebhookRequest {
  readonly method: "POST";
  /** The part of the path after `/frontends/<agent>/<binding-id>/`. */
  readonly pathSuffix: string;
  /** Header names are lowercase. Repeated headers are joined with `, `. */
  readonly headers: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  /** The raw body, at most 256 KiB, for signature checks. */
  readonly body: Uint8Array;
}

/** The HTTP response for a `WebhookRequest`. */
export interface WebhookResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
}

/** Handles one Frontend webhook request. The adapter verifies the request itself (ADR 0012). */
export type WebhookRouteHandler = (
  request: WebhookRequest
) => Promise<WebhookResponse>;

/** A mounted Frontend webhook route. */
export interface WebhookRoute {
  /** The mounted path, for example `/frontends/home/telegram-main/updates`. */
  readonly path: string;
  /** Removes the route. Repeated calls do nothing. */
  readonly unregister: () => void;
}

/** Services that Wheatley gives a Frontend when it creates a Frontend Binding. */
export interface FrontendContext {
  readonly agentName: string;
  readonly bindingId: string;
  readonly secrets: SecretReader;
  readonly log: Logger;
  /** A per-Agent directory for staged attachments. Wheatley deletes old files in it. */
  readonly stagingDir: string;
  /**
   * A persistent per-binding directory that survives daemon restarts, for adapter state such as the platform message
   * of each `approval_requested` delivery. Wheatley creates it and never deletes files in it.
   */
  readonly dataDir: string;
  /** The per-file attachment limit. The default is 10 MiB. */
  readonly maxAttachmentBytes: number;
  /**
   * Mounts `POST /frontends/<agent>/<binding-id>/<pathSuffix>` on the Webhook Ingress (ADR 0012).
   *
   * Absent if the Webhook Ingress is disabled. An adapter in webhook mode must then throw from `createBinding`. Throws
   * if `pathSuffix` is empty, contains `..`, or is already mounted for this binding.
   */
  readonly registerWebhookRoute?: (
    pathSuffix: string,
    handler: WebhookRouteHandler
  ) => WebhookRoute;
}

/**
 * One running Frontend endpoint for one Agent (ADR 0007).
 *
 * Wheatley calls `start` once, then any number of `deliver` and `onEvent` calls, then `stop` once.
 */
export interface FrontendBinding {
  /** Connects to the platform and starts to forward inbound messages to `sink`. */
  readonly start: (sink: FrontendSink) => Promise<void>;
  /**
   * Delivers durable outbound work. Resolves once the platform confirmed it.
   *
   * Rejects with a `DeliveryError`: `permanent` for a deleted Chat or a removed bot, otherwise `retryable`. The outbox
   * treats any other error as retryable. A retry can deliver the same `messageId` twice.
   */
  readonly deliver: (delivery: Delivery) => Promise<void>;
  /** Receives ephemeral live progress. Must not throw or block. Omit it for minimal adapters. */
  readonly onEvent?: (event: RunEvent) => void;
  /** Disconnects. Wheatley sends no `deliver` or `onEvent` calls after `stop` starts. */
  readonly stop: () => Promise<void>;
}

/**
 * A kind of chat surface, such as Telegram, that a Plugin or Wheatley provides.
 *
 * Each `frontends` entry of an Agent in `config.yaml` with this `type` creates one Frontend Binding.
 */
export interface Frontend<Config = JsonValue> {
  /** The `type` value in `config.yaml`, for example `telegram`. */
  readonly type: string;
  /** Wheatley validates the binding config against it before `createBinding`. */
  readonly configSchema: SchemaInput<Config>;
  /** Creates a binding from validated config. Throw to report invalid setup, for example a missing secret. */
  readonly createBinding: (
    config: Config,
    ctx: FrontendContext
  ) => Promise<FrontendBinding> | FrontendBinding;
}
