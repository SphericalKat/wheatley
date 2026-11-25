import type { ApprovalDecision, PendingApproval } from "@wheatley/protocol";
import { useState } from "react";

import { useServices, useStore } from "../hooks.js";
import { approvalKey } from "../models/inbox.js";
import {
  ActionButton,
  Badge,
  ErrorText,
  formatTime,
  inputClass,
} from "./ui.js";

const DECISIONS: readonly {
  readonly decision: ApprovalDecision;
  readonly label: string;
}[] = [
  { decision: "allow_once", label: "Allow once" },
  { decision: "allow_conversation", label: "Allow for this Conversation" },
  { decision: "allow_always", label: "Always allow" },
];

/** A pending Approval with the four decisions: Allow once, Allow for this Conversation, Always allow, and Deny. */
export const ApprovalCard = ({
  approval,
}: {
  readonly approval: PendingApproval;
}) => {
  const { inbox } = useServices();
  const { busy, itemErrors } = useStore(inbox.state);
  const [reason, setReason] = useState("");
  const key = approvalKey(approval);
  const pending = busy.has(key);

  return (
    <li className="space-y-2 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge color="indigo">{approval.agent}</Badge>
        <span className="font-mono font-semibold">{approval.toolName}</span>
        <span className="text-zinc-500">
          {approval.chat === null
            ? "No Chat"
            : `${approval.chat.bindingId} / ${approval.chat.chatId}`}
        </span>
        <span className="text-zinc-500">
          asked {formatTime(approval.createdAt)}
        </span>
        {approval.expiresAt === null ? null : (
          <span className="text-zinc-500">
            expires {formatTime(approval.expiresAt)}
          </span>
        )}
      </div>
      <pre className="overflow-x-auto rounded bg-zinc-100 p-2 text-xs dark:bg-zinc-950">
        {approval.inputPreview}
      </pre>
      <div className="flex flex-wrap items-center gap-2">
        {DECISIONS.map(({ decision, label }) => (
          <ActionButton
            disabled={pending}
            key={decision}
            onClick={async () => {
              await inbox.decide(approval, decision);
            }}
            tone={decision === "allow_once" ? "primary" : "neutral"}
          >
            {label}
          </ActionButton>
        ))}
        <input
          aria-label="Reason for a denial"
          className={`${inputClass} max-w-xs`}
          onChange={(event) => {
            setReason(event.target.value);
          }}
          placeholder="Reason (optional)"
          value={reason}
        />
        <ActionButton
          disabled={pending}
          onClick={async () => {
            await inbox.decide(approval, "deny", reason);
          }}
          tone="danger"
        >
          Deny
        </ActionButton>
      </div>
      <ErrorText error={itemErrors.get(key) ?? null} />
    </li>
  );
};
