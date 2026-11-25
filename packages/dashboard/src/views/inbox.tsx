import type {
  ApprovalDecision,
  FailedDelivery,
  PendingApproval,
} from "@wheatley/protocol";
import { useState } from "react";

import { useServices, useStore } from "../hooks.js";
import { approvalKey, deliveryKey } from "../models/inbox.js";
import {
  ActionButton,
  Badge,
  Empty,
  ErrorText,
  formatTime,
  inputClass,
  Notice,
  PageHeader,
  Panel,
} from "./ui.js";

const DECISIONS: readonly {
  readonly decision: ApprovalDecision;
  readonly label: string;
}[] = [
  { decision: "allow_once", label: "Allow once" },
  { decision: "allow_conversation", label: "Allow for this Conversation" },
  { decision: "allow_always", label: "Always allow" },
];

const ApprovalCard = ({ approval }: { readonly approval: PendingApproval }) => {
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

const DeliveryCard = ({ delivery }: { readonly delivery: FailedDelivery }) => {
  const { inbox } = useServices();
  const { busy, itemErrors } = useStore(inbox.state);
  const key = deliveryKey(delivery);
  const pending = busy.has(key);

  return (
    <li className="space-y-2 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge color="indigo">{delivery.agent}</Badge>
        <span className="font-mono">
          {delivery.bindingId} / {delivery.chatId}
        </span>
        <Badge color="zinc">{delivery.kind.replace("_", " ")}</Badge>
        {delivery.permanent ? (
          <Badge color="red">permanent failure</Badge>
        ) : null}
        <span className="text-zinc-500">
          {delivery.attempts} attempts, last {formatTime(delivery.failedAt)}
        </span>
      </div>
      <p className="text-sm">{delivery.preview}</p>
      <p className="font-mono text-xs text-red-600">{delivery.lastError}</p>
      <div className="flex gap-2">
        <ActionButton
          disabled={pending}
          onClick={async () => {
            await inbox.retry(delivery);
          }}
          tone="primary"
        >
          Retry
        </ActionButton>
        <ActionButton
          disabled={pending}
          onClick={async () => {
            await inbox.dismiss(delivery);
          }}
        >
          Dismiss
        </ActionButton>
      </div>
      <ErrorText error={itemErrors.get(key) ?? null} />
    </li>
  );
};

/** The Inbox: pending Approvals with Approve and Deny, and failed deliveries with Retry and Dismiss. */
export const InboxView = () => {
  const { inbox } = useServices();

  const { approvals, deliveries, error, loading, notice } = useStore(
    inbox.state
  );

  return (
    <div className="space-y-4">
      <PageHeader
        actions={
          <ActionButton
            onClick={async () => {
              await inbox.refresh();
            }}
          >
            Refresh
          </ActionButton>
        }
        subtitle="The first decision from any client wins."
        title="Inbox"
      />
      <ErrorText error={error} />
      {notice === null ? null : <Notice>{notice}</Notice>}
      <Panel title={`Pending Approvals (${approvals.length})`}>
        {approvals.length === 0 ? (
          <Empty>
            {loading ? "Loading…" : "No Approval waits for a decision."}
          </Empty>
        ) : (
          <ul className="space-y-3">
            {approvals.map((approval) => (
              <ApprovalCard approval={approval} key={approvalKey(approval)} />
            ))}
          </ul>
        )}
      </Panel>
      <Panel title={`Failed Deliveries (${deliveries.length})`}>
        {deliveries.length === 0 ? (
          <Empty>{loading ? "Loading…" : "No delivery failed."}</Empty>
        ) : (
          <ul className="space-y-3">
            {deliveries.map((delivery) => (
              <DeliveryCard delivery={delivery} key={deliveryKey(delivery)} />
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
};
