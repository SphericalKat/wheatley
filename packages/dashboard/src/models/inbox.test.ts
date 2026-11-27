import { RpcError, RpcErrorCode } from "@wheatley-ai/protocol";
import type { EventPayload } from "@wheatley-ai/protocol";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { startHarness } from "../../mock/harness.js";
import type { Harness } from "../../mock/harness.js";
import { holdClient } from "./hold-client.js";
import {
  approvalKey,
  chatApprovals,
  createInbox,
  deliveryKey,
  OPERATOR_DISPLAY_NAME,
} from "./inbox.js";
import type { Inbox } from "./inbox.js";

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness();
});

afterEach(async () => {
  await harness.close();
});

const loadedInbox = async (): Promise<Inbox> => {
  const inbox = createInbox(await harness.connect());

  await vi.waitFor(() => {
    expect(inbox.state.get().loading).toBe(false);
  });

  return inbox;
};

const firstApproval = (inbox: Inbox) => {
  const [approval] = inbox.state.get().approvals;

  if (approval === undefined) {
    throw new Error("The fixture has no pending Approval");
  }

  return approval;
};

const firstDelivery = (inbox: Inbox) => {
  const [delivery] = inbox.state.get().deliveries;

  if (delivery === undefined) {
    throw new Error("The fixture has no failed delivery");
  }

  return delivery;
};

test("loads the pending Approvals and failed deliveries of every Agent", async () => {
  const inbox = await loadedInbox();

  expect(inbox.state.get()).toMatchObject({
    approvals: [{ approvalId: "approval-1", toolName: "shell" }],
    deliveries: [
      { deliveryId: "delivery-1", lastError: "ETIMEDOUT api.telegram.org" },
    ],
    error: null,
  });
});

test("approves an Approval as the Operator and removes it from every open Inbox", async () => {
  const inbox = await loadedInbox();
  const otherTab = await loadedInbox();
  const approval = firstApproval(inbox);

  await inbox.decide(approval, "allow_once");

  expect(inbox.state.get()).toMatchObject({ approvals: [], notice: null });
  expect(inbox.state.get().busy.has(approvalKey(approval))).toBe(false);
  expect(harness.daemon.state.approvals).toEqual([]);
  expect(
    harness.daemon.state.runs.find((run) => run.runId === approval.runId)
      ?.status
  ).toBe("running");
  await vi.waitFor(() => {
    expect(otherTab.state.get().approvals).toEqual([]);
  });
});

test("sends the deny reason and the Operator attribution", async () => {
  const inbox = await loadedInbox();

  const resolved =
    vi.fn<(payload: EventPayload<"approval.resolved">) => void>();

  const watcher = await harness.connect();

  watcher.on("approval.resolved", (payload) => {
    resolved(payload);
  });
  await inbox.decide(firstApproval(inbox), "deny", "Not now");

  await vi.waitFor(() => {
    expect(resolved).toHaveBeenCalledWith({
      agent: "home",
      approvalId: "approval-1",
      decision: "deny",
      reason: "Not now",
      resolvedBy: OPERATOR_DISPLAY_NAME,
    });
  });
});

test("reports a decision that lost to another client and drops the Approval", async () => {
  const inbox = await loadedInbox();
  const approval = firstApproval(inbox);

  // Another frontend decided, and this tab has not seen the event yet.
  harness.daemon.state.approvals = [];
  await inbox.decide(approval, "allow_always");

  expect(inbox.state.get()).toMatchObject({
    approvals: [],
    notice: "Another client decided first, or the Approval ended.",
  });
});

test("keeps an Approval and records the error if the decision request fails", async () => {
  const inbox = await loadedInbox();
  const approval = firstApproval(inbox);

  harness.daemon.override("approvals.decide", () => {
    throw new RpcError(RpcErrorCode.AgentUnavailable, "Agent home is stopped");
  });
  await inbox.decide(approval, "allow_once");

  expect(inbox.state.get().approvals).toEqual([approval]);
  expect(inbox.state.get().itemErrors.get(approvalKey(approval))).toBe(
    "Agent home is stopped"
  );
  expect(inbox.state.get().busy.size).toBe(0);
});

test("adds Approvals and failed deliveries from live events", async () => {
  const inbox = await loadedInbox();
  const approval = { ...firstApproval(inbox), approvalId: "approval-2" };

  const delivery = {
    ...firstDelivery(inbox),
    deliveryId: "delivery-2",
    failedAt: "2099-01-01T00:00:00.000Z",
  };

  harness.daemon.emit("approval.requested", { agent: "home", approval });
  harness.daemon.emit("delivery.failed", { agent: "home", delivery });

  await vi.waitFor(() => {
    expect(
      inbox.state.get().approvals.map((entry) => entry.approvalId)
    ).toEqual(["approval-1", "approval-2"]);
    expect(
      inbox.state.get().deliveries.map((entry) => entry.deliveryId)
    ).toEqual(["delivery-2", "delivery-1"]);
  });
});

test("retries a failed delivery and clears it from the Inbox", async () => {
  const inbox = await loadedInbox();
  const delivery = firstDelivery(inbox);

  await inbox.retry(delivery);

  expect(inbox.state.get().deliveries).toEqual([]);
  expect(inbox.state.get().itemErrors.size).toBe(0);
  expect(harness.daemon.state.deliveries).toEqual([]);
  expect(harness.daemon.received).toContain("deliveries.retry");
});

test("reports a retry of a delivery that already left the outbox", async () => {
  const inbox = await loadedInbox();
  const delivery = firstDelivery(inbox);

  harness.daemon.state.deliveries = [];
  await inbox.retry(delivery);

  expect(inbox.state.get()).toMatchObject({
    deliveries: [],
    notice: "The delivery had already left the outbox.",
  });
});

test("keeps a delivery with its error if the outbox does not requeue it", async () => {
  const inbox = await loadedInbox();
  const delivery = firstDelivery(inbox);

  harness.daemon.override("deliveries.retry", () => ({ requeued: false }));
  await inbox.retry(delivery);

  expect(inbox.state.get().deliveries).toEqual([delivery]);
  expect(inbox.state.get().itemErrors.get(deliveryKey(delivery))).toBe(
    "The outbox did not take the delivery back."
  );
});

test("dismisses a failed delivery", async () => {
  const inbox = await loadedInbox();

  await inbox.dismiss(firstDelivery(inbox));

  expect(inbox.state.get().deliveries).toEqual([]);
  expect(harness.daemon.state.deliveries).toEqual([]);
});

test("selects the pending Approvals of one Chat of one Agent and drops them after a decision", async () => {
  const inbox = await loadedInbox();
  const cliChat = { bindingId: "cli", chatId: "default" };

  const cliApproval = {
    ...firstApproval(inbox),
    approvalId: "approval-cli",
    chat: cliChat,
  };

  harness.daemon.state.approvals.push(cliApproval);
  harness.daemon.emit("approval.requested", {
    agent: "home",
    approval: cliApproval,
  });
  harness.daemon.emit("approval.requested", {
    agent: "work",
    approval: { ...cliApproval, agent: "work", approvalId: "approval-work" },
  });

  await vi.waitFor(() => {
    expect(inbox.state.get().approvals).toHaveLength(3);
  });
  expect(
    chatApprovals(inbox.state.get(), "home", cliChat).map(
      (entry) => entry.approvalId
    )
  ).toEqual(["approval-cli"]);

  await inbox.decide(cliApproval, "allow_conversation");

  expect(chatApprovals(inbox.state.get(), "home", cliChat)).toEqual([]);
  expect(inbox.state.get().approvals.map((entry) => entry.approvalId)).toEqual([
    "approval-1",
    "approval-work",
  ]);
});

test("reloads the Inbox after a reconnect", async () => {
  const inbox = await loadedInbox();

  harness.daemon.state.approvals = [];
  harness.daemon.dropConnections();

  await vi.waitFor(() => {
    expect(inbox.state.get().approvals).toEqual([]);
  });
});

test("keeps an Approval and a failed delivery that arrive during a refresh", async () => {
  const reference = await loadedInbox();

  const held = holdClient(await harness.connect(), [
    "approvals.list",
    "deliveries.listFailed",
  ]);

  const inbox = createInbox(held.client);
  const approval = { ...firstApproval(reference), approvalId: "approval-new" };

  const delivery = {
    ...firstDelivery(reference),
    deliveryId: "delivery-new",
  };

  held.emit("approval.requested", { agent: approval.agent, approval });
  held.emit("delivery.failed", { agent: delivery.agent, delivery });
  held.release();

  await vi.waitFor(() => {
    expect(inbox.state.get().loading).toBe(false);
  });

  expect(
    inbox.state.get().approvals.map((entry) => entry.approvalId)
  ).toContain("approval-new");
  expect(
    inbox.state.get().deliveries.map((entry) => entry.deliveryId)
  ).toContain("delivery-new");
});

test("does not bring back an Approval or delivery that ended during a refresh", async () => {
  const reference = await loadedInbox();
  const approval = firstApproval(reference);
  const delivery = firstDelivery(reference);

  const held = holdClient(await harness.connect(), [
    "approvals.list",
    "deliveries.listFailed",
  ]);

  const inbox = createInbox(held.client);

  held.emit("approval.resolved", {
    agent: approval.agent,
    approvalId: approval.approvalId,
    decision: "allow_once",
  });
  held.emit("delivery.cleared", {
    agent: delivery.agent,
    deliveryId: delivery.deliveryId,
    reason: "dismissed",
  });
  held.release();

  await vi.waitFor(() => {
    expect(inbox.state.get().loading).toBe(false);
  });

  expect(inbox.state.get()).toMatchObject({ approvals: [], deliveries: [] });
});
