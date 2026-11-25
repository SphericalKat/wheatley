import type {
  ChatKey,
  JsonValue,
  PendingApproval,
  PermissionAction,
  PermissionRule,
} from "@wheatley/protocol";
import type { ApprovalResolution } from "@wheatley/sdk";

import type { ConfigStore, SecretStore } from "./config-store.js";
import type { DeliveryOutbox } from "./delivery-outbox.js";

/** One Tool call that waits at the gate, as the Agent's pi adapter sees it. */
export interface GatedToolCall {
  /**
   * Stable for one Tool call across parks, wakes, and daemon restarts, for example the pi-durable Tool task ID. The
   * gate keys Approvals by it, so a repeated check of the same call never opens a second Approval.
   */
  readonly callKey: string;
  readonly runId: string;
  readonly conversationId: string;
  /** The originating Chat, or `null` for a Run without a Chat. */
  readonly chat: ChatKey | null;
  /** The canonical Tool name, for example `shell`, `notes:add`, or `mcp:github:create_issue`. */
  readonly toolName: string;
  readonly input: JsonValue;
  /** False for Trigger, maintenance, and non-TTY `wheatley ask` Runs. An `ask` then becomes a denial. */
  readonly interactive: boolean;
}

/** Why the gate denied a call. */
export type DenyReason =
  | "policy"
  | "decision"
  | "timeout"
  | "cancelled"
  | "non_interactive";

/** What the pi adapter does with a call. */
export type GateVerdict =
  /** Run the call. */
  | { readonly kind: "allow" }
  /** Return `{ isError: true }` with `message` to the model. The Run continues. */
  | {
      readonly kind: "deny";
      readonly reason: DenyReason;
      readonly message: string;
    }
  /**
   * Park the call in a pi-durable signal sleep on `signalKey` until `deps.wake` names that key or the deadline passes,
   * then call `check` again. `expiresAt` is epoch milliseconds, or `null` for no deadline.
   *
   * `signalKey` is `<callKey>:<approvalId>`: the same for every check of one call on one Approval, and new when the
   * call waits on another Approval. pi-durable consumes a key on the wake that uses it and ends a second sleep on it
   * with `invalid_park`, so a call that waits twice (step 7, then step 8) needs two keys.
   */
  | {
      readonly kind: "wait";
      readonly approvalId: string;
      readonly signalKey: string;
      readonly expiresAt: number | null;
    };

/** A parked call: the pi-durable task to signal and the key that it sleeps on. */
export interface ParkedCall {
  readonly callKey: string;
  readonly signalKey: string;
}

/** Who decides an Approval: a Sender in a Chat, or the Operator through the CLI or dashboard. */
export type DecisionOrigin =
  | {
      readonly kind: "chat";
      readonly bindingId: string;
      readonly chatId: string;
    }
  | { readonly kind: "operator" };

/**
 * Evaluates the Permission Policy and runs Approvals for one Agent (ADR 0011). The pi adapter calls `check` from a
 * pi-durable `beforeTool` hook, which reruns after every wake.
 */
export interface ApprovalGate {
  /**
   * Decides a Tool call. Idempotent per `callKey`: call it again after every wake.
   *
   * Order:
   * 1. The first matching `permissionPolicy` rule, else the Tool's default action, else `ask`.
   * 2. `deny` returns `deny` (`policy`). An explicit `deny` rule beats every grant.
   * 3. `allow`, or `ask` with an `allow_conversation` grant for `(conversationId, toolName)`, returns `allow`.
   * 4. `ask` in a non-interactive Run returns `deny` (`non_interactive`).
   * 5. A resolved Approval for `callKey` returns `allow` for any allow decision, else `deny` with its reason.
   * 6. A pending Approval for `callKey` returns `wait`, or `deny` (`timeout`) after its deadline, which also
   *    resolves it as `timeout`.
   * 7. If another Approval of the same Run is pending, returns `wait` on that Approval without a new prompt, so
   *    Approvals are serialized per Run. If that Approval's deadline passed, the gate first resolves it as `timeout`
   *    (with the side effects of `decide`) and continues with step 8.
   * 8. Otherwise opens an Approval: stores it, enqueues `approval_requested` for the Chat, emits
   *    `approval.requested`, and returns `wait`.
   *
   * Approval IDs are unguessable (for example a random UUID), because a Chat decision carries only the ID. The
   * `inputPreview` is `SecretStore.redact(JSON.stringify(call.input))` cut to 500 characters; `redact` also replaces
   * the JSON-escaped form of each secret value, so escapes cannot hide a secret.
   */
  readonly check: (call: GatedToolCall) => Promise<GateVerdict>;
  /**
   * Resolves a pending Approval. The first decision from any surface wins; later calls and unknown IDs resolve
   * `false`. A `chat` origin must equal the Approval's originating Chat (ADR 0002), else the call resolves `false`
   * and changes nothing. The Operator can decide every Approval.
   *
   * On success, in order: stores the decision before the first `await`, so a concurrent call sees it; applies
   * `allow_conversation` (grant) or `allow_always` (`ConfigStore.prependPermissionRule` and the live policy);
   * enqueues `approval_resolved`; emits `approval.resolved`; calls `deps.wake` for every call waiting on the Approval.
   */
  readonly decide: (
    approvalId: string,
    resolution: ApprovalResolution,
    origin: DecisionOrigin
  ) => Promise<boolean>;
  /**
   * Resolves every pending Approval of the Run as `cancelled` for `/stop`, with the same side effects as `decide`.
   * Resolves with the number of cancelled Approvals.
   */
  readonly cancelRun: (runId: string) => Promise<number>;
  /** Removes the `allow_conversation` grants of a Conversation, for `/new`. */
  readonly clearConversationGrants: (conversationId: string) => Promise<void>;
  /** Lists pending Approvals, oldest first. */
  readonly listPending: () => Promise<readonly PendingApproval[]>;
}

/** What the gate needs from the Agent. */
export interface ApprovalGateDeps {
  /** The Agent's rules from `config.yaml` at start. The gate keeps its own live copy after `allow_always`. */
  readonly policy: readonly PermissionRule[];
  /** The default action of a built-in Tool, or `undefined` for Plugin and MCP Tools (which default to `ask`). */
  readonly defaultAction: (toolName: string) => PermissionAction | undefined;
  /** Milliseconds until an Approval times out, or `null` for no timeout. The default config value is `15m`. */
  readonly timeoutMs: number | null;
  readonly config: Pick<ConfigStore, "prependPermissionRule">;
  readonly secrets: Pick<SecretStore, "redact">;
  readonly outbox: Pick<DeliveryOutbox, "enqueue">;
  /**
   * Wakes the parked calls, for example through `harness.signal(callKey, signal, signalKey, ...)`. Called after the
   * decision is stored, so a woken call that runs `check` sees it.
   */
  readonly wake: (calls: readonly ParkedCall[]) => Promise<void>;
}
