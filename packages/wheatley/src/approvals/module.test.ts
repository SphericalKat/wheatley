import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ApprovalGateDeps } from "../contracts/approval-gate.js";
import { InMemoryConfigStore } from "../contracts/config-store.fake.js";
import { InMemoryDeliveryOutbox } from "../contracts/delivery-outbox.fake.js";
import { migrationNamespace } from "../contracts/module.js";
import type { AgentModuleContext, RpcContext } from "../contracts/module.js";
import { InMemorySecretStore } from "../contracts/secret-store.fake.js";
import { openAgentDatabase } from "../db/database.js";
import { runMigrations } from "../db/migrations.js";
import { approvalsModule } from "./module.js";

const RPC: RpcContext = {
  connectionId: "connection-1",
  signal: new AbortController().signal,
};

let db: DatabaseSync;

const context = (): AgentModuleContext => ({
  agentDir: "/data/agents/home",
  agentName: "home",
  clock: { now: () => Date.parse("2026-11-26T09:00:00.000Z") },
  db,
  events: { emit: () => {} },
  log: { debug: () => {}, error: () => {}, info: () => {}, warn: () => {} },
});

const deps = (): ApprovalGateDeps => {
  const store = new InMemoryConfigStore(
    {
      agents: { home: { model: "faux/faux-1" } },
      version: 1,
    },
    new InMemorySecretStore()
  );

  return {
    config: store,
    defaultAction: () => {},
    outbox: new InMemoryDeliveryOutbox("home", {
      deliver: async () => {},
      onDelivered: async () => {},
    }),
    policy: [],
    secrets: store.secrets,
    timeoutMs: null,
    wake: async () => {},
  };
};

beforeEach(() => {
  db = openAgentDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("approvals module", () => {
  it("applies its migrations once in the approvals namespace", () => {
    const applied = runMigrations(db, [migrationNamespace(approvalsModule)]);

    expect(applied.map(({ namespace }) => namespace)).toStrictEqual([
      "approvals",
    ]);
    expect(
      runMigrations(db, [migrationNamespace(approvalsModule)])
    ).toStrictEqual([]);
  });

  it("lists pending Approvals and decides one as the Operator through JSON-RPC", async () => {
    runMigrations(db, [migrationNamespace(approvalsModule)]);
    const { api: gate, rpc } = await approvalsModule.create(context(), deps());

    await gate.check({
      callKey: "c1",
      chat: { bindingId: "telegram-main", chatId: "42" },
      conversationId: "conversation-1",
      input: { command: "ls" },
      interactive: true,
      runId: "run-1",
      toolName: "shell",
    });

    const listed = await rpc["approvals.list"]?.({ agent: "home" }, RPC);
    const [approval] = listed?.approvals ?? [];

    expect(approval).toMatchObject({
      agent: "home",
      chat: { bindingId: "telegram-main", chatId: "42" },
      createdAt: "2026-11-26T09:00:00.000Z",
      expiresAt: null,
      inputPreview: '{"command":"ls"}',
      runId: "run-1",
      toolName: "shell",
    });

    const decide = rpc["approvals.decide"];

    const params = {
      agent: "home",
      approvalId: approval?.approvalId ?? "",
      resolution: { decision: "deny", reason: "no" },
    } as const;

    await expect(decide?.(params, RPC)).resolves.toStrictEqual({
      accepted: true,
    });
    await expect(decide?.(params, RPC)).resolves.toStrictEqual({
      accepted: false,
    });
    await expect(rpc["approvals.list"]?.({}, RPC)).resolves.toStrictEqual({
      approvals: [],
    });
  });
});
