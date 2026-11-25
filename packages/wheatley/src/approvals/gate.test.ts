import type { DatabaseSync } from "node:sqlite";

import type {
  DeploymentConfig,
  EventName,
  EventPayload,
  PermissionAction,
  PermissionRule,
} from "@wheatley-ai/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  ApprovalGate,
  ApprovalGateDeps,
  DecisionOrigin,
  GatedToolCall,
  GateVerdict,
  ParkedCall,
} from "../contracts/approval-gate.js";
import { InMemoryConfigStore } from "../contracts/config-store.fake.js";
import { InMemoryDeliveryOutbox } from "../contracts/delivery-outbox.fake.js";
import type { AgentModuleContext } from "../contracts/module.js";
import { migrationNamespace } from "../contracts/module.js";
import { InMemorySecretStore } from "../contracts/secret-store.fake.js";
import { openAgentDatabase } from "../db/database.js";
import { runMigrations } from "../db/migrations.js";
import { createApprovalGate } from "./gate.js";
import { approvalsModule } from "./module.js";
import { approvalTimeoutMs, isInteractiveRun } from "./policy.js";

const TIMEOUT_MS = 60_000;
const SECRET = "sk-secret-value";
const PREVIEW_LIMIT = 500;

const OPERATOR: DecisionOrigin = { kind: "operator" };

const CHAT: DecisionOrigin = {
  bindingId: "telegram-main",
  chatId: "42",
  kind: "chat",
};

const builtinDefaults = new Map<string, PermissionAction>([
  ["read_file", "allow"],
  ["write_file", "ask"],
  ["shell", "ask"],
]);

interface EmittedEvent {
  readonly name: EventName;
  readonly payload: EventPayload<EventName>;
}

let now = 0;
let db: DatabaseSync;
let store: InMemoryConfigStore;
let outbox: InMemoryDeliveryOutbox;
let woken: ParkedCall[] = [];
let emitted: EmittedEvent[] = [];
let errors: string[] = [];

const configWith = (policy: PermissionRule[]): DeploymentConfig => ({
  agents: {
    home: {
      model: { id: "faux-1", provider: "faux" },
      permissionPolicy: policy,
    },
  },
  version: 1,
});

const context = (): AgentModuleContext => ({
  agentDir: "/data/agents/home",
  agentName: "home",
  clock: { now: () => now },
  db,
  events: {
    emit: (name, payload) => {
      emitted.push({ name, payload });
    },
  },
  log: {
    debug: () => {},
    error: (message) => {
      errors.push(message);
    },
    info: () => {},
    warn: () => {},
  },
});

const depsFor = (
  policy: readonly PermissionRule[],
  overrides: Partial<ApprovalGateDeps> = {}
): ApprovalGateDeps => ({
  config: store,
  defaultAction: (toolName) => builtinDefaults.get(toolName),
  outbox,
  policy,
  secrets: store.secrets,
  timeoutMs: TIMEOUT_MS,
  wake: async (calls) => {
    await Promise.resolve();
    woken.push(...calls);
  },
  ...overrides,
});

const gateWith = (
  policy: PermissionRule[] = [],
  overrides: Partial<ApprovalGateDeps> = {}
): ApprovalGate => {
  store = new InMemoryConfigStore(
    configWith(policy),
    new InMemorySecretStore({ API_TOKEN: SECRET })
  );

  return createApprovalGate(context(), depsFor(policy, overrides));
};

const call = (
  callKey: string,
  toolName = "write_file",
  overrides: Partial<GatedToolCall> = {}
): GatedToolCall => ({
  callKey,
  chat: { bindingId: "telegram-main", chatId: "42" },
  conversationId: "conversation-1",
  input: { path: "notes.md", token: SECRET },
  interactive: true,
  runId: "run-1",
  toolName,
  ...overrides,
});

const approvalIdOf = (verdict: GateVerdict): string => {
  if (verdict.kind !== "wait") {
    throw new Error(`Expected a wait verdict, got ${verdict.kind}`);
  }

  return verdict.approvalId;
};

const deliveryKinds = (): string[] =>
  outbox.entries.map((entry) => entry.delivery.kind);

const pendingIds = async (gate: ApprovalGate): Promise<string[]> => {
  const pending = await gate.listPending();

  return pending.map(({ approvalId }) => approvalId);
};

const eventNames = (): EventName[] => emitted.map(({ name }) => name);

beforeEach(() => {
  now = 1_000_000;
  woken = [];
  emitted = [];
  errors = [];
  db = openAgentDatabase(":memory:");
  runMigrations(db, [migrationNamespace(approvalsModule)]);
  outbox = new InMemoryDeliveryOutbox("home", {
    deliver: async () => {},
    onDelivered: async () => {},
  });
});

afterEach(() => {
  db.close();
});

describe("permission policy precedence", () => {
  it("lets the first matching rule win over later rules and the default action", async () => {
    const gate = gateWith([
      { action: "deny", tool: "notes:delete" },
      { action: "allow", tool: "notes:*" },
      { action: "deny", tool: "notes:add" },
      { action: "allow", tool: "write_file" },
      { action: "ask", tool: "read_file" },
    ]);

    await expect(gate.check(call("c1", "notes:delete"))).resolves.toMatchObject(
      {
        kind: "deny",
        reason: "policy",
      }
    );
    await expect(gate.check(call("c2", "notes:add"))).resolves.toStrictEqual({
      kind: "allow",
    });
    await expect(gate.check(call("c3", "write_file"))).resolves.toStrictEqual({
      kind: "allow",
    });
    await expect(gate.check(call("c4", "read_file"))).resolves.toMatchObject({
      kind: "wait",
    });
  });

  it("uses the built-in default action, then ask for Plugin and MCP Tools", async () => {
    const gate = gateWith();

    await expect(gate.check(call("c1", "read_file"))).resolves.toStrictEqual({
      kind: "allow",
    });
    await expect(
      gate.check(call("c2", "mcp:github:create_issue"))
    ).resolves.toMatchObject({ kind: "wait" });
  });

  it("treats only * as a wildcard and matches case-sensitively", async () => {
    const gate = gateWith([
      { action: "allow", tool: "mcp:github:*" },
      { action: "allow", tool: "browser.navigate" },
      { action: "deny", tool: "*" },
    ]);

    await expect(
      gate.check(call("c1", "mcp:github:create_issue"))
    ).resolves.toStrictEqual({ kind: "allow" });
    await expect(
      gate.check(call("c2", "mcp:x:browser.navigate"))
    ).resolves.toMatchObject({
      kind: "deny",
    });
    await expect(
      gate.check(call("c3", "browserXnavigate"))
    ).resolves.toMatchObject({
      kind: "deny",
    });
    await expect(
      gate.check(call("c4", "mcp:GitHub:create_issue"))
    ).resolves.toMatchObject({
      kind: "deny",
    });
  });

  it("keeps an explicit deny rule above an allow_conversation grant", async () => {
    const gate = gateWith([{ action: "deny", tool: "shell" }]);
    const approvalId = approvalIdOf(await gate.check(call("c1")));
    await gate.decide(approvalId, { decision: "allow_conversation" }, CHAT);

    await expect(gate.check(call("c2", "shell"))).resolves.toMatchObject({
      kind: "deny",
      reason: "policy",
    });
    await expect(gate.check(call("c3"))).resolves.toStrictEqual({
      kind: "allow",
    });
  });
});

describe("serialized ask parking", () => {
  it("opens one Approval per Run and parks later calls on it without a second prompt", async () => {
    const gate = gateWith();

    const [first, second] = await Promise.all([
      gate.check(call("c1")),
      gate.check(call("c2")),
    ]);

    const approvalId = approvalIdOf(first);

    expect(second).toStrictEqual({
      approvalId,
      expiresAt: now + TIMEOUT_MS,
      kind: "wait",
      signalKey: `c2:${approvalId}`,
    });
    expect(first).toMatchObject({ signalKey: `c1:${approvalId}` });
    expect(await gate.listPending()).toHaveLength(1);
    expect(deliveryKinds()).toStrictEqual(["approval_requested"]);
    expect(eventNames()).toStrictEqual(["approval.requested"]);
  });

  it("returns the same wait verdict when a parked call checks again", async () => {
    const gate = gateWith();
    const first = await gate.check(call("c1"));

    await expect(gate.check(call("c1"))).resolves.toStrictEqual(first);
    expect(deliveryKinds()).toStrictEqual(["approval_requested"]);
  });

  it("wakes every parked call and then opens the next call's own Approval with a new signal key", async () => {
    const gate = gateWith();
    const blocking = approvalIdOf(await gate.check(call("c1")));
    await gate.check(call("c2"));

    await gate.decide(blocking, { decision: "allow_once" }, CHAT);

    expect(woken.map(({ signalKey }) => signalKey).toSorted()).toStrictEqual([
      `c1:${blocking}`,
      `c2:${blocking}`,
    ]);

    const own = await gate.check(call("c2"));
    const ownId = approvalIdOf(own);

    expect(ownId).not.toBe(blocking);
    expect(own).toMatchObject({ signalKey: `c2:${ownId}` });
    await expect(gate.check(call("c1"))).resolves.toStrictEqual({
      kind: "allow",
    });
  });

  it("does not block a call of another Run", async () => {
    const gate = gateWith();
    const first = approvalIdOf(await gate.check(call("c1")));

    const other = approvalIdOf(
      await gate.check(call("c2", "write_file", { runId: "run-2" }))
    );

    expect(other).not.toBe(first);
    expect(await gate.listPending()).toHaveLength(2);
  });

  it("builds a redacted preview of at most 500 characters with the deadline", async () => {
    const gate = gateWith();
    await gate.check(
      call("c1", "write_file", {
        input: { content: "x".repeat(PREVIEW_LIMIT), token: SECRET },
      })
    );
    const [pending] = await gate.listPending();
    const [entry] = outbox.entries;

    expect(pending?.inputPreview).toHaveLength(PREVIEW_LIMIT);
    expect(pending?.inputPreview).not.toContain("sk-secret");
    expect(pending?.expiresAt).toBe(new Date(now + TIMEOUT_MS).toISOString());
    expect(entry?.delivery).toMatchObject({
      expiresAt: pending?.expiresAt,
      inputPreview: pending?.inputPreview,
      kind: "approval_requested",
      runId: "run-1",
      toolName: "write_file",
    });
  });

  it("redacts a secret before the cut, so no part of it leaks", async () => {
    const gate = gateWith();
    await gate.check(call("c1", "write_file", { input: { token: SECRET } }));
    const [pending] = await gate.listPending();

    expect(pending?.inputPreview).toBe('{"token":"[redacted]"}');
  });

  it("keeps pending Approvals and grants across a new gate on the same agent.sqlite", async () => {
    const gate = gateWith();
    const approvalId = approvalIdOf(await gate.check(call("c1")));

    const granted = approvalIdOf(
      await gate.check(call("c9", "shell", { runId: "run-2" }))
    );

    await gate.decide(granted, { decision: "allow_conversation" }, CHAT);

    const restarted = createApprovalGate(context(), depsFor([]));

    await expect(pendingIds(restarted)).resolves.toStrictEqual([approvalId]);
    await expect(restarted.check(call("c1"))).resolves.toMatchObject({
      approvalId,
      kind: "wait",
    });
    await expect(
      restarted.check(call("c10", "shell", { runId: "run-3" }))
    ).resolves.toStrictEqual({
      kind: "allow",
    });
    await expect(
      restarted.decide(approvalId, { decision: "allow_once" }, OPERATOR)
    ).resolves.toBe(true);
    await expect(restarted.check(call("c1"))).resolves.toStrictEqual({
      kind: "allow",
    });
  });
});

describe("decisions", () => {
  it("allow_once allows only the decided call", async () => {
    const gate = gateWith();
    const approvalId = approvalIdOf(await gate.check(call("c1")));

    await expect(
      gate.decide(
        approvalId,
        { decision: "allow_once", resolvedBy: "Ana" },
        CHAT
      )
    ).resolves.toBe(true);
    await expect(gate.check(call("c1"))).resolves.toStrictEqual({
      kind: "allow",
    });
    await expect(gate.check(call("c2"))).resolves.toMatchObject({
      kind: "wait",
    });
    expect(outbox.entries[1]?.delivery).toMatchObject({
      approvalId,
      decision: "allow_once",
      kind: "approval_resolved",
      resolvedBy: "Ana",
    });
    expect(emitted[1]).toStrictEqual({
      name: "approval.resolved",
      payload: {
        agent: "home",
        approvalId,
        decision: "allow_once",
        reason: undefined,
        resolvedBy: "Ana",
      },
    });
  });

  it("allow_conversation allows the Tool for the Conversation until /new clears the grant", async () => {
    const gate = gateWith();
    const approvalId = approvalIdOf(await gate.check(call("c1")));
    await gate.decide(approvalId, { decision: "allow_conversation" }, CHAT);

    await expect(gate.check(call("c2"))).resolves.toStrictEqual({
      kind: "allow",
    });
    await expect(
      gate.check(
        call("c3", "write_file", {
          conversationId: "conversation-2",
          runId: "run-2",
        })
      )
    ).resolves.toMatchObject({ kind: "wait" });

    await gate.clearConversationGrants("conversation-1");

    await expect(
      gate.check(call("c4", "write_file", { runId: "run-3" }))
    ).resolves.toMatchObject({ kind: "wait" });
  });

  it("allow_always prepends an exact-tool rule to config.yaml and applies it to the live policy at once", async () => {
    const gate = gateWith([{ action: "ask", tool: "*" }]);

    const approvalId = approvalIdOf(
      await gate.check(call("c1", "mcp:github:create_issue"))
    );

    await gate.check(call("c2", "mcp:github:create_issue"));

    await gate.decide(approvalId, { decision: "allow_always" }, OPERATOR);
    const { config: saved } = await store.read();

    expect(saved.agents.home?.permissionPolicy).toStrictEqual([
      { action: "allow", tool: "mcp:github:create_issue" },
      { action: "ask", tool: "*" },
    ]);
    await expect(
      gate.check(call("c2", "mcp:github:create_issue"))
    ).resolves.toStrictEqual({ kind: "allow" });
    await expect(
      gate.check(
        call("c3", "mcp:github:create_issue", {
          conversationId: "other",
          runId: "run-2",
        })
      )
    ).resolves.toStrictEqual({ kind: "allow" });
    await expect(
      gate.check(call("c4", "mcp:github:list_issues", { runId: "run-3" }))
    ).resolves.toMatchObject({ kind: "wait" });
  });

  it("keeps an allow_always decision live, wakes the call, and rejects if config.yaml cannot take the rule", async () => {
    const gate = gateWith([], {
      config: {
        prependPermissionRule: async () => {
          await Promise.resolve();
          throw new Error("disk full");
        },
      },
    });

    const approvalId = approvalIdOf(await gate.check(call("c1")));

    await expect(
      gate.decide(approvalId, { decision: "allow_always" }, OPERATOR)
    ).rejects.toThrow("config.yaml did not save the allow_always rule");
    await expect(gate.check(call("c1"))).resolves.toStrictEqual({
      kind: "allow",
    });
    await expect(
      gate.check(call("c2", "write_file", { runId: "run-2" }))
    ).resolves.toStrictEqual({
      kind: "allow",
    });
    expect(deliveryKinds()).toStrictEqual([
      "approval_requested",
      "approval_resolved",
    ]);
    expect(woken.map(({ callKey }) => callKey)).toStrictEqual(["c1"]);
  });

  it("logs a failed enqueue and still completes the decision and the wake", async () => {
    const gate = gateWith([], {
      outbox: {
        enqueue: async () => {
          await Promise.resolve();
          throw new Error("outbox closed");
        },
      },
    });

    const approvalId = approvalIdOf(await gate.check(call("c1")));

    await expect(
      gate.decide(approvalId, { decision: "allow_once" }, CHAT)
    ).resolves.toBe(true);
    await expect(gate.check(call("c1"))).resolves.toStrictEqual({
      kind: "allow",
    });
    expect(errors).toStrictEqual([
      "Could not enqueue approval_requested",
      "Could not enqueue approval_resolved",
    ]);
    expect(woken.map(({ callKey }) => callKey)).toStrictEqual(["c1"]);
  });

  it("deny returns an error result with the reason, and the Run continues to the next call", async () => {
    const gate = gateWith();
    const approvalId = approvalIdOf(await gate.check(call("c1")));
    await gate.check(call("c2"));

    await gate.decide(
      approvalId,
      { decision: "deny", reason: "not now" },
      CHAT
    );
    const verdict = await gate.check(call("c1"));

    expect(verdict).toStrictEqual({
      kind: "deny",
      message: "The Approval for write_file was denied: not now",
      reason: "decision",
    });
    await expect(gate.check(call("c2"))).resolves.toMatchObject({
      kind: "wait",
    });
    expect(outbox.entries[1]?.delivery).toMatchObject({
      decision: "deny",
      kind: "approval_resolved",
      reason: "not now",
    });
  });

  it("lets only the first of two concurrent decisions win", async () => {
    const gate = gateWith();
    const approvalId = approvalIdOf(await gate.check(call("c1")));

    await expect(
      Promise.all([
        gate.decide(approvalId, { decision: "deny" }, CHAT),
        gate.decide(approvalId, { decision: "allow_always" }, OPERATOR),
      ])
    ).resolves.toStrictEqual([true, false]);
    expect(deliveryKinds()).toStrictEqual([
      "approval_requested",
      "approval_resolved",
    ]);
    const { config: saved } = await store.read();

    expect(saved.agents.home?.permissionPolicy).toStrictEqual([]);
  });

  it("accepts a decision only from the originating Chat or the Operator", async () => {
    const gate = gateWith();
    const approvalId = approvalIdOf(await gate.check(call("c1")));

    const cliApproval = approvalIdOf(
      await gate.check(call("c2", "write_file", { chat: null, runId: "run-2" }))
    );

    await expect(
      gate.decide(
        approvalId,
        { decision: "allow_once" },
        { bindingId: "telegram-main", chatId: "99", kind: "chat" }
      )
    ).resolves.toBe(false);
    await expect(
      gate.decide(cliApproval, { decision: "allow_once" }, CHAT)
    ).resolves.toBe(false);
    await expect(
      gate.decide("unknown", { decision: "allow_once" }, OPERATOR)
    ).resolves.toBe(false);
    expect(await gate.listPending()).toHaveLength(2);
    await expect(
      gate.decide(cliApproval, { decision: "allow_once" }, OPERATOR)
    ).resolves.toBe(true);
  });
});

describe("timeout", () => {
  it("denies a call after its deadline and resolves the Approval as timeout", async () => {
    const gate = gateWith();
    const approvalId = approvalIdOf(await gate.check(call("c1")));
    now += TIMEOUT_MS;

    await expect(gate.check(call("c1"))).resolves.toStrictEqual({
      kind: "deny",
      message: "No decision on write_file before the Approval timed out",
      reason: "timeout",
    });
    expect(await gate.listPending()).toHaveLength(0);
    expect(outbox.entries[1]?.delivery).toMatchObject({
      approvalId,
      decision: "timeout",
      kind: "approval_resolved",
    });
    expect(woken).toStrictEqual([]);
  });

  it("refuses a decision after the deadline", async () => {
    const gate = gateWith();
    const approvalId = approvalIdOf(await gate.check(call("c1")));
    now += TIMEOUT_MS;

    await expect(
      gate.decide(approvalId, { decision: "allow_once" }, CHAT)
    ).resolves.toBe(false);
    await expect(gate.check(call("c1"))).resolves.toMatchObject({
      reason: "timeout",
    });
    expect(woken).toStrictEqual([
      { callKey: "c1", signalKey: `c1:${approvalId}` },
    ]);
  });

  it("times out an expired blocking Approval and opens the waiting call's own Approval", async () => {
    const gate = gateWith();
    const blocking = approvalIdOf(await gate.check(call("c1")));
    await gate.check(call("c2"));
    now += TIMEOUT_MS;

    const verdict = await gate.check(call("c2"));

    expect(verdict).toMatchObject({
      expiresAt: now + TIMEOUT_MS,
      kind: "wait",
    });
    await expect(pendingIds(gate)).resolves.toStrictEqual([
      approvalIdOf(verdict),
    ]);
    expect(woken).toStrictEqual([
      { callKey: "c1", signalKey: `c1:${blocking}` },
    ]);
    expect(deliveryKinds()).toStrictEqual([
      "approval_requested",
      "approval_resolved",
      "approval_requested",
    ]);
  });

  it("never times out when the timeout is null", async () => {
    const gate = gateWith([], { timeoutMs: approvalTimeoutMs(null) });
    const verdict = await gate.check(call("c1"));
    now += 365 * 24 * 60 * TIMEOUT_MS;

    expect(verdict).toMatchObject({ expiresAt: null, kind: "wait" });
    await expect(gate.check(call("c1"))).resolves.toStrictEqual(verdict);
    const [pending] = await gate.listPending();

    expect(pending?.expiresAt).toBeNull();
  });

  it("defaults to 15 minutes", () => {
    expect(approvalTimeoutMs(undefined)).toBe(15 * TIMEOUT_MS);
    expect(approvalTimeoutMs("30s")).toBe(TIMEOUT_MS / 2);
  });
});

describe("/stop cancellation", () => {
  it("cancels the pending Approval of the Run and denies every parked call with cancelled", async () => {
    const gate = gateWith();
    const approvalId = approvalIdOf(await gate.check(call("c1")));
    await gate.check(call("c2"));
    await gate.check(call("c3", "write_file", { runId: "run-2" }));

    await expect(gate.cancelRun("run-1")).resolves.toBe(1);

    expect(emitted.at(-1)).toStrictEqual({
      name: "approval.resolved",
      payload: {
        agent: "home",
        approvalId,
        decision: "cancelled",
        reason: undefined,
        resolvedBy: undefined,
      },
    });
    expect(woken.map(({ callKey }) => callKey).toSorted()).toStrictEqual([
      "c1",
      "c2",
    ]);

    const stopped = {
      kind: "deny",
      message: "The Run stopped before a decision on write_file",
      reason: "cancelled",
    } as const;

    await expect(gate.check(call("c1"))).resolves.toStrictEqual(stopped);
    await expect(gate.check(call("c2"))).resolves.toStrictEqual(stopped);
    await expect(
      gate.decide(approvalId, { decision: "allow_once" }, CHAT)
    ).resolves.toBe(false);
    expect(await gate.listPending()).toHaveLength(1);
    expect(deliveryKinds()).toStrictEqual([
      "approval_requested",
      "approval_requested",
      "approval_resolved",
    ]);
    await expect(gate.cancelRun("run-1")).resolves.toBe(0);
  });
});

describe("auto-deny contexts", () => {
  const origins = [
    ["a Trigger Run", isInteractiveRun({ kind: "trigger", triggerId: "t1" })],
    [
      "a maintenance Run",
      isInteractiveRun({ job: "memory-consolidation", kind: "maintenance" }),
    ],
    [
      "a non-TTY wheatley ask Run",
      isInteractiveRun(
        { bindingId: "cli", chatId: "default", kind: "chat" },
        { interactive: false }
      ),
    ],
  ] as const;

  it.each(origins)(
    "denies an ask Tool in %s without a prompt",
    async (_label, interactive) => {
      const gate = gateWith([{ action: "allow", tool: "notes:*" }]);

      await expect(
        gate.check(call("c1", "write_file", { interactive }))
      ).resolves.toMatchObject({
        kind: "deny",
        reason: "non_interactive",
      });
      await expect(
        gate.check(call("c2", "notes:add", { interactive }))
      ).resolves.toStrictEqual({
        kind: "allow",
      });
      expect(outbox.entries).toHaveLength(0);
      expect(emitted).toHaveLength(0);
      expect(await gate.listPending()).toHaveLength(0);
    }
  );

  it("prompts in a Chat Run and in a TTY wheatley ask Run", () => {
    expect(
      isInteractiveRun({
        bindingId: "telegram-main",
        chatId: "42",
        kind: "chat",
      })
    ).toBe(true);
    expect(
      isInteractiveRun(
        { bindingId: "cli", chatId: "default", kind: "chat" },
        { interactive: true }
      )
    ).toBe(true);
  });
});
