import type { ApprovalGate } from "../contracts/approval-gate.js";
import type { RpcHandlerMap } from "../contracts/module.js";

/**
 * The JSON-RPC handlers of the `approvals` module: `approvals.list` and `approvals.decide`. A decision through
 * JSON-RPC comes from the CLI or the dashboard, so it has the Operator origin and can decide every Approval of the
 * Agent (ADR 0002).
 *
 * Errors: `approvals.decide` rejects if `ApprovalGate.decide` rejects, for example after a failed wake or a failed
 * `config.yaml` write. The decision stays stored in both cases.
 */
export const createApprovalsRpc = (gate: ApprovalGate): RpcHandlerMap => ({
  "approvals.decide": async ({ approvalId, resolution }) => ({
    accepted: await gate.decide(approvalId, resolution, { kind: "operator" }),
  }),
  "approvals.list": async () => ({
    approvals: [...(await gate.listPending())],
  }),
});
