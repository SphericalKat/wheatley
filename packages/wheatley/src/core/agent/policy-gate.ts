import type { DatabaseSync } from "node:sqlite";

import type { PermissionAction, PermissionRule } from "@wheatley/protocol";
import type { Logger } from "@wheatley/sdk";

import type {
  ApprovalGate,
  ParkedCall,
} from "../../contracts/approval-gate.js";
import type { Clock, EventSink } from "../../contracts/module.js";
import { matchesToolPattern } from "../../contracts/tool-names.js";

/** What the Agent gives the factory of its `ApprovalGate`. */
export interface ApprovalHost {
  readonly agentName: string;
  /** The Agent's `permissionPolicy` from `config.yaml` at start. */
  readonly policy: readonly PermissionRule[];
  /** The default action of a built-in Tool, or `undefined` for Plugin and MCP Tools. */
  readonly defaultAction: (toolName: string) => PermissionAction | undefined;
  /** The Approval timeout in milliseconds, or `null` for none. */
  readonly timeoutMs: number | null;
  /** Wakes parked Tool calls through their pi-durable signal sleep. */
  readonly wake: (calls: readonly ParkedCall[]) => Promise<void>;
  readonly events: EventSink;
  readonly clock: Clock;
  /** The open `agent.sqlite` handle, with the migrations of every module applied. The gate stores Approvals in it. */
  readonly db: DatabaseSync;
  readonly log: Logger;
}

/** Creates the `ApprovalGate` of one Agent. The Approvals module provides the real factory. */
export type ApprovalGateFactory = (host: ApprovalHost) => ApprovalGate;

/** The action of the first matching rule, else the Tool's default action, else `ask` (ADR 0011). */
export const evaluatePolicy = (
  policy: readonly PermissionRule[],
  toolName: string,
  defaultAction: PermissionAction | undefined
): PermissionAction =>
  policy.find((rule) => matchesToolPattern(rule.tool, toolName))?.action ??
  defaultAction ??
  "ask";

/**
 * The gate of an Agent that runs without the Approvals module. It applies the Permission Policy and denies every `ask`
 * Tool, because nobody can answer an Approval. It stores nothing, so `decide` and `cancelRun` find no Approvals.
 */
export const createPolicyOnlyGate = (host: ApprovalHost): ApprovalGate => ({
  cancelRun: async () => {
    await Promise.resolve();

    return 0;
  },
  check: async (call) => {
    await Promise.resolve();

    const action = evaluatePolicy(
      host.policy,
      call.toolName,
      host.defaultAction(call.toolName)
    );

    if (action === "allow") {
      return { kind: "allow" };
    }

    return action === "deny"
      ? {
          kind: "deny",
          message: `The Permission Policy denies ${call.toolName}`,
          reason: "policy",
        }
      : {
          kind: "deny",
          message: `${call.toolName} needs an Approval, and this Agent has no Approval gate`,
          reason: "non_interactive",
        };
  },
  clearConversationGrants: async () => {
    await Promise.resolve();
  },
  decide: async () => {
    await Promise.resolve();

    return false;
  },
  listPending: async () => {
    await Promise.resolve();

    return [];
  },
});
