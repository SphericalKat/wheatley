import { randomUUID } from "node:crypto";

import type {
  ApprovalOutcome,
  PendingApproval,
  PermissionAction,
  PermissionRule,
} from "@wheatley/protocol";
import type { ApprovalResolution } from "@wheatley/sdk";

import type {
  ApprovalGate,
  ApprovalGateDeps,
  DecisionOrigin,
  DenyReason,
  GatedToolCall,
  GateVerdict,
} from "./approval-gate.js";
import { simulateIo } from "./fake-io.js";
import { systemClock } from "./module.js";
import type { Clock, EventSink } from "./module.js";
import { matchesToolPattern } from "./tool-names.js";

const PREVIEW_LENGTH = 500;

interface ApprovalRecord {
  readonly approval: PendingApproval;
  readonly callKey: string;
  readonly expiresAt: number | null;
  /** Parked calls by `callKey`, with the `signalKey` of each. */
  readonly waiters: Map<string, string>;
  outcome: ApprovalOutcome | undefined;
  reason: string | undefined;
}

const grantKey = (conversationId: string, toolName: string): string =>
  `${conversationId}\u0000${toolName}`;

const isAllow = (outcome: ApprovalOutcome): boolean =>
  outcome === "allow_once" ||
  outcome === "allow_conversation" ||
  outcome === "allow_always";

const signalKeyOf = (callKey: string, approvalId: string): string =>
  `${callKey}:${approvalId}`;

/** Registers `callKey` as a waiter of the Approval and returns its `wait` verdict. */
const park = (record: ApprovalRecord, callKey: string): GateVerdict => {
  const { approvalId } = record.approval;
  const signalKey = signalKeyOf(callKey, approvalId);
  record.waiters.set(callKey, signalKey);

  return { approvalId, expiresAt: record.expiresAt, kind: "wait", signalKey };
};

const sameChat = (
  origin: DecisionOrigin,
  chat: PendingApproval["chat"]
): boolean =>
  origin.kind === "operator" ||
  (chat !== null &&
    origin.bindingId === chat.bindingId &&
    origin.chatId === chat.chatId);

const denial = (reason: DenyReason, message: string): GateVerdict => ({
  kind: "deny",
  message,
  reason,
});

/** Options of the fake gate. */
export interface FakeApprovalGateOptions {
  readonly clock?: Clock;
  readonly events?: EventSink;
}

/** An in-memory `ApprovalGate` that follows the documented `check` order. */
export class InMemoryApprovalGate implements ApprovalGate {
  readonly #agentName: string;
  readonly #deps: ApprovalGateDeps;
  readonly #clock: Clock;
  readonly #events: EventSink | undefined;
  readonly #rules: PermissionRule[];
  readonly #grants = new Set<string>();
  readonly #approvals = new Map<string, ApprovalRecord>();

  constructor(
    agentName: string,
    deps: ApprovalGateDeps,
    options: FakeApprovalGateOptions = {}
  ) {
    this.#agentName = agentName;
    this.#deps = deps;
    this.#clock = options.clock ?? systemClock;
    this.#events = options.events;
    this.#rules = [...deps.policy];
  }

  readonly check = async (call: GatedToolCall): Promise<GateVerdict> => {
    await simulateIo();
    const action = this.#evaluate(call.toolName);

    if (action === "deny") {
      return denial("policy", `The Permission Policy denies ${call.toolName}`);
    }

    if (
      action === "allow" ||
      this.#grants.has(grantKey(call.conversationId, call.toolName))
    ) {
      return { kind: "allow" };
    }

    if (!call.interactive) {
      return denial(
        "non_interactive",
        `${call.toolName} needs an Approval, and this Run cannot ask for one`
      );
    }

    const own = [...this.#approvals.values()].find(
      (record) => record.callKey === call.callKey
    );

    if (own !== undefined) {
      return await this.#verdictFor(own, call);
    }

    const blocking = [...this.#approvals.values()].find(
      (record) =>
        record.outcome === undefined && record.approval.runId === call.runId
    );

    if (blocking === undefined) {
      return await this.#open(call);
    }

    if (this.#expired(blocking)) {
      await this.#resolve(blocking, "timeout");

      return await this.#open(call);
    }

    return park(blocking, call.callKey);
  };

  readonly decide = async (
    approvalId: string,
    resolution: ApprovalResolution,
    origin: DecisionOrigin
  ): Promise<boolean> => {
    await simulateIo();
    const record = this.#approvals.get(approvalId);

    if (
      record === undefined ||
      record.outcome !== undefined ||
      !sameChat(origin, record.approval.chat)
    ) {
      return false;
    }

    // Claim the Approval before the first await, so a concurrent decision or cancelRun resolves false.
    record.outcome = resolution.decision;
    record.reason = resolution.reason;
    const { conversationId, toolName } = record.approval;

    if (resolution.decision === "allow_conversation") {
      this.#grants.add(grantKey(conversationId, toolName));
    }

    if (resolution.decision === "allow_always") {
      const rule: PermissionRule = { action: "allow", tool: toolName };
      await this.#deps.config.prependPermissionRule(this.#agentName, rule);
      this.#rules.unshift(rule);
    }

    await this.#resolve(
      record,
      resolution.decision,
      resolution.resolvedBy,
      resolution.reason
    );

    return true;
  };

  readonly cancelRun = async (runId: string): Promise<number> => {
    await simulateIo();

    const pending = [...this.#approvals.values()].filter(
      (record) =>
        record.outcome === undefined && record.approval.runId === runId
    );

    await Promise.all(
      pending.map(async (record) => {
        await this.#resolve(record, "cancelled");
      })
    );

    return pending.length;
  };

  readonly clearConversationGrants = async (
    conversationId: string
  ): Promise<void> => {
    await simulateIo();

    for (const key of this.#grants) {
      if (key.startsWith(`${conversationId}\u0000`)) {
        this.#grants.delete(key);
      }
    }
  };

  readonly listPending = async (): Promise<readonly PendingApproval[]> => {
    await simulateIo();

    return [...this.#approvals.values()].flatMap((record) =>
      record.outcome === undefined ? [record.approval] : []
    );
  };

  readonly #evaluate = (toolName: string): PermissionAction => {
    const rule = this.#rules.find((candidate) =>
      matchesToolPattern(candidate.tool, toolName)
    );

    return rule?.action ?? this.#deps.defaultAction(toolName) ?? "ask";
  };

  readonly #verdictFor = async (
    record: ApprovalRecord,
    call: GatedToolCall
  ): Promise<GateVerdict> => {
    if (record.outcome === undefined) {
      if (!this.#expired(record)) {
        return park(record, call.callKey);
      }

      await this.#resolve(record, "timeout");
    }

    const outcome = record.outcome ?? "timeout";

    if (isAllow(outcome)) {
      return { kind: "allow" };
    }

    if (outcome === "deny") {
      const suffix = record.reason === undefined ? "" : `: ${record.reason}`;

      return denial(
        "decision",
        `The Approval for ${call.toolName} was denied${suffix}`
      );
    }

    return outcome === "timeout"
      ? denial(
          "timeout",
          `No decision on ${call.toolName} before the Approval timed out`
        )
      : denial(
          "cancelled",
          `The Run stopped before a decision on ${call.toolName}`
        );
  };

  readonly #expired = (record: ApprovalRecord): boolean =>
    record.expiresAt !== null && this.#clock.now() >= record.expiresAt;

  readonly #open = async (call: GatedToolCall): Promise<GateVerdict> => {
    const approvalId = `approval-${randomUUID()}`;
    const now = this.#clock.now();

    const expiresAt =
      this.#deps.timeoutMs === null ? null : now + this.#deps.timeoutMs;

    const inputPreview = this.#deps.secrets
      .redact(JSON.stringify(call.input))
      .slice(0, PREVIEW_LENGTH);

    const approval: PendingApproval = {
      agent: this.#agentName,
      approvalId,
      chat: call.chat,
      conversationId: call.conversationId,
      createdAt: new Date(now).toISOString(),
      expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(),
      inputPreview,
      runId: call.runId,
      toolName: call.toolName,
    };

    const record: ApprovalRecord = {
      approval,
      callKey: call.callKey,
      expiresAt,
      outcome: undefined,
      reason: undefined,
      waiters: new Map(),
    };

    this.#approvals.set(approvalId, record);
    const verdict = park(record, call.callKey);

    if (call.chat !== null) {
      await this.#deps.outbox.enqueue({
        bindingId: call.chat.bindingId,
        chatId: call.chat.chatId,
        delivery: {
          approvalId,
          expiresAt: approval.expiresAt,
          inputPreview,
          kind: "approval_requested",
          runId: call.runId,
          toolName: call.toolName,
        },
      });
    }

    this.#events?.emit("approval.requested", {
      agent: this.#agentName,
      approval,
    });

    return verdict;
  };

  readonly #resolve = async (
    record: ApprovalRecord,
    outcome: ApprovalOutcome,
    resolvedBy?: string,
    reason?: string
  ): Promise<void> => {
    record.outcome = outcome;
    record.reason = reason;
    const { approvalId, chat } = record.approval;

    if (chat !== null) {
      await this.#deps.outbox.enqueue({
        bindingId: chat.bindingId,
        chatId: chat.chatId,
        delivery: {
          approvalId,
          decision: outcome,
          kind: "approval_resolved",
          reason,
          resolvedBy,
        },
      });
    }

    this.#events?.emit("approval.resolved", {
      agent: this.#agentName,
      approvalId,
      decision: outcome,
      reason,
      resolvedBy,
    });
    await this.#deps.wake(
      [...record.waiters].map(([callKey, signalKey]) => ({
        callKey,
        signalKey,
      }))
    );
  };
}
