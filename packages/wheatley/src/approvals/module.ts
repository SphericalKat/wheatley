import type {
  ApprovalGate,
  ApprovalGateDeps,
} from "../contracts/approval-gate.js";
import type { AgentModule } from "../contracts/module.js";
import { createApprovalGate } from "./gate.js";
import { createApprovalsRpc } from "./rpc.js";
import { approvalsMigrations } from "./store.js";

export { createApprovalsRpc } from "./rpc.js";

export { approvalsMigrations } from "./store.js";

/**
 * The `approvals` Agent module (ADR 0011). Its API is the Agent's `ApprovalGate`. Its migration namespace is
 * `approvals`, and it handles `approvals.list` and `approvals.decide`.
 *
 * Build `deps.timeoutMs` with `approvalTimeoutMs(agentConfig.approvalTimeout)` and `GatedToolCall.interactive` with
 * `isInteractiveRun`, both from `policy.ts`. The CLI renders Approval prompts with `promptForApproval` from `prompt.ts`.
 */
export const approvalsModule: AgentModule<ApprovalGateDeps, ApprovalGate> = {
  create: (ctx, deps) => {
    const gate = createApprovalGate(ctx, deps);

    return { api: gate, rpc: createApprovalsRpc(gate) };
  },
  migrations: approvalsMigrations,
  name: "approvals",
  scope: "agent",
};
