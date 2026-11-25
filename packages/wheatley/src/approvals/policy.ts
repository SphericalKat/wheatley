import { parseDuration } from "@wheatley-ai/protocol";
import type {
  Duration,
  PermissionAction,
  PermissionRule,
  RunOrigin,
} from "@wheatley-ai/protocol";

import { matchesToolPattern } from "../contracts/tool-names.js";

/** The Approval timeout when the Agent config has no `approvalTimeout` (ADR 0011). */
export const DEFAULT_APPROVAL_TIMEOUT: Duration = "15m";

/**
 * Returns the action of the Permission Policy for a canonical Tool name.
 *
 * Order: the first rule whose `tool` pattern matches (only `*` is a wildcard), else the Tool's default action, else
 * `ask`. Plugin and MCP Tools have no default action, so they fall back to `ask`.
 */
export const policyAction = (
  rules: readonly PermissionRule[],
  toolName: string,
  defaultAction: (toolName: string) => PermissionAction | undefined
): PermissionAction => {
  const rule = rules.find((candidate) =>
    matchesToolPattern(candidate.tool, toolName)
  );

  return rule?.action ?? defaultAction(toolName) ?? "ask";
};

/**
 * Converts the `approvalTimeout` value of an Agent config to `ApprovalGateDeps.timeoutMs`: `undefined` gives the
 * `15m` default, and `null` disables the timeout. Throws a `RangeError` for an invalid duration.
 */
export const approvalTimeoutMs = (
  approvalTimeout: Duration | null | undefined
): number | null => {
  if (approvalTimeout === null) {
    return null;
  }

  return parseDuration(approvalTimeout ?? DEFAULT_APPROVAL_TIMEOUT);
};

/**
 * Returns the `GatedToolCall.interactive` value of a Run (ADR 0011). Trigger and maintenance Runs are never
 * interactive. A Chat Run is interactive, except a `wheatley ask` Run that the CLI sent with `interactive: false`
 * because it has no TTY.
 */
export const isInteractiveRun = (
  origin: RunOrigin,
  cliAsk?: { readonly interactive: boolean }
): boolean => origin.kind === "chat" && (cliAsk?.interactive ?? true);
