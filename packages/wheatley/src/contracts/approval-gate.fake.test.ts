import type { DeploymentConfig, PermissionAction } from "@wheatley/protocol";
import { beforeEach, describe, expect, it } from "vitest";

import { InMemoryApprovalGate } from "./approval-gate.fake.js";
import type { ApprovalGateDeps, GatedToolCall } from "./approval-gate.js";
import { InMemoryConfigStore } from "./config-store.fake.js";
import { InMemoryDeliveryOutbox } from "./delivery-outbox.fake.js";
import { InMemorySecretStore } from "./secret-store.fake.js";

const TIMEOUT_MS = 60_000;

const config: DeploymentConfig = {
  agents: {
    home: {
      model: { id: "faux-1", provider: "faux" },
      permissionPolicy: [{ action: "deny", tool: "shell" }],
    },
  },
  version: 1,
};

const builtinDefaults = new Map<string, PermissionAction>([
  ["read_file", "allow"],
  ["write_file", "ask"],
]);

let now = 0;
let woken: string[] = [];
let store: InMemoryConfigStore;
let outbox: InMemoryDeliveryOutbox;
let gate: InMemoryApprovalGate;

const call = (
  callKey: string,
  toolName: string,
  overrides: Partial<GatedToolCall> = {}
): GatedToolCall => ({
  callKey,
  chat: { bindingId: "telegram-main", chatId: "42" },
  conversationId: "conversation-1",
  input: { path: "notes.md", token: "sk-secret-value" },
  interactive: true,
  runId: "run-1",
  toolName,
  ...overrides,
});

beforeEach(() => {
  now = 1_000_000;
  woken = [];
  store = new InMemoryConfigStore(
    config,
    new InMemorySecretStore({ API_TOKEN: "sk-secret-value" })
  );
  outbox = new InMemoryDeliveryOutbox("home", {
    deliver: async () => {},
    onDelivered: async () => {},
  });

  const deps: ApprovalGateDeps = {
    config: store,
    defaultAction: (toolName) => builtinDefaults.get(toolName),
    outbox,
    policy: config.agents.home?.permissionPolicy ?? [],
    secrets: store.secrets,
    timeoutMs: TIMEOUT_MS,
    wake: async (callKeys) => {
      await Promise.resolve();
      woken.push(...callKeys);
    },
  };

  gate = new InMemoryApprovalGate("home", deps, { clock: { now: () => now } });
});

describe("InMemoryApprovalGate", () => {
  it("allows a Tool whose default action is allow and denies a Tool with a deny rule", async () => {
    await expect(gate.check(call("c1", "read_file"))).resolves.toStrictEqual({
      kind: "allow",
    });
    await expect(gate.check(call("c2", "shell"))).resolves.toMatchObject({
      kind: "deny",
      reason: "policy",
    });
  });

  it("denies an ask Tool in a non-interactive Run without a prompt", async () => {
    await expect(
      gate.check(call("c1", "write_file", { interactive: false }))
    ).resolves.toMatchObject({
      kind: "deny",
      reason: "non_interactive",
    });
    expect(outbox.entries).toHaveLength(0);
  });

  it("opens one Approval per call, redacts the preview, and lets the first decision win", async () => {
    const first = await gate.check(call("c1", "write_file"));
    const again = await gate.check(call("c1", "write_file"));
    const [pending] = await gate.listPending();

    expect(first).toMatchObject({ expiresAt: now + TIMEOUT_MS, kind: "wait" });
    expect(again).toStrictEqual(first);
    expect(pending?.inputPreview).toContain("[redacted]");
    expect(pending?.inputPreview).not.toContain("sk-secret-value");
    await expect(
      gate.decide(pending?.approvalId ?? "", { decision: "allow_once" })
    ).resolves.toBe(true);
    await expect(
      gate.decide(pending?.approvalId ?? "", { decision: "deny" })
    ).resolves.toBe(false);
    expect(woken).toStrictEqual(["c1"]);
    await expect(gate.check(call("c1", "write_file"))).resolves.toStrictEqual({
      kind: "allow",
    });
    expect(outbox.entries.map((entry) => entry.delivery.kind)).toStrictEqual([
      "approval_requested",
      "approval_resolved",
    ]);
  });

  it("serializes Approvals per Run and lets allow_conversation clear the next call", async () => {
    const first = await gate.check(call("c1", "write_file"));
    const second = await gate.check(call("c2", "write_file"));

    expect(second).toStrictEqual(first);
    expect(await gate.listPending()).toHaveLength(1);

    await gate.decide(first.kind === "wait" ? first.approvalId : "", {
      decision: "allow_conversation",
    });

    expect(woken.toSorted()).toStrictEqual(["c1", "c2"]);
    await expect(gate.check(call("c2", "write_file"))).resolves.toStrictEqual({
      kind: "allow",
    });

    await gate.clearConversationGrants("conversation-1");
    await expect(gate.check(call("c3", "write_file"))).resolves.toMatchObject({
      kind: "wait",
    });
  });

  it("keeps an explicit deny rule above an allow_conversation grant", async () => {
    const verdict = await gate.check(call("c1", "write_file"));
    await gate.decide(verdict.kind === "wait" ? verdict.approvalId : "", {
      decision: "allow_conversation",
    });

    await expect(gate.check(call("c2", "shell"))).resolves.toMatchObject({
      kind: "deny",
      reason: "policy",
    });
  });

  it("persists allow_always as a config rule and applies it at once", async () => {
    const verdict = await gate.check(call("c1", "write_file"));
    await gate.decide(verdict.kind === "wait" ? verdict.approvalId : "", {
      decision: "allow_always",
    });

    const { config: saved } = await store.read();

    expect(saved.agents.home?.permissionPolicy?.[0]).toStrictEqual({
      action: "allow",
      tool: "write_file",
    });
    await expect(
      gate.check(
        call("c9", "write_file", { conversationId: "other", runId: "run-2" })
      )
    ).resolves.toStrictEqual({ kind: "allow" });
  });

  it("returns the deny reason and times out an unanswered Approval", async () => {
    const denied = await gate.check(call("c1", "write_file"));
    await gate.decide(denied.kind === "wait" ? denied.approvalId : "", {
      decision: "deny",
      reason: "not now",
    });

    const verdict = await gate.check(call("c1", "write_file"));

    expect(verdict).toMatchObject({ kind: "deny", reason: "decision" });
    expect(verdict.kind === "deny" ? verdict.message : "").toContain("not now");

    await gate.check(call("c2", "write_file", { runId: "run-2" }));
    now += TIMEOUT_MS;

    await expect(
      gate.check(call("c2", "write_file", { runId: "run-2" }))
    ).resolves.toMatchObject({
      kind: "deny",
      reason: "timeout",
    });
    expect(await gate.listPending()).toHaveLength(0);
  });

  it("cancels the pending Approvals of a stopped Run", async () => {
    await gate.check(call("c1", "write_file"));

    await expect(gate.cancelRun("run-1")).resolves.toBe(1);
    await expect(gate.check(call("c1", "write_file"))).resolves.toMatchObject({
      kind: "deny",
      reason: "cancelled",
    });
  });
});
