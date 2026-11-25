// Flow 6: the live dashboard that the daemon serves on `/` and `/ws`. A browser-like client (a WebSocket with an
// `Origin` header) drives the Approvals Inbox, the Config editor, and Agent create, rename, and delete over JSON-RPC.
import { once } from "node:events";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { FauxResponseFactory } from "@earendil-works/pi-ai";
import {
  decodeServerMessage,
  encodeRequest,
  PROTOCOL_VERSION,
  RpcError,
  RpcErrorCode,
} from "@wheatley/protocol";
import type {
  AgentConfig,
  DeploymentConfig,
  EventName,
  EventPayload,
  MethodName,
  MethodParams,
  MethodResult,
  RpcEvent,
  RpcId,
  RpcResult,
} from "@wheatley/protocol";
import { afterEach, expect, it } from "vitest";
import { WebSocket } from "ws";

import { FAKE_PROVIDER } from "../../src/core/test-support.js";
import { startHarness, waitFor } from "./harness.js";
import type { Harness } from "./harness.js";

const FIXTURE_DIR = path.join(import.meta.dirname, "fixtures", "06-dashboard");

/** An origin that `daemon.allowedOrigins` lists, for example a dashboard behind a reverse proxy. */
const PROXY_ORIGIN = "http://dashboard.example:8080";

const FOREIGN_ORIGIN = "http://evil.example";

const UPGRADE_OK = 101;
const UPGRADE_FORBIDDEN = 403;

const ALLOW_ALL = [{ action: "allow", tool: "*" }] as const;

/** A JSON-RPC session over `/ws` that sends a browser `Origin`, as the dashboard does. */
interface DashboardSession {
  readonly request: <M extends MethodName>(
    method: M,
    params: MethodParams<M>
  ) => Promise<MethodResult<M>>;
  readonly waitForEvent: <E extends EventName>(
    name: E,
    predicate?: (payload: EventPayload<E>) => boolean
  ) => Promise<EventPayload<E>>;
}

interface Pending {
  readonly method: MethodName;
  readonly settle: (response: RpcResult | RpcError) => void;
}

let harness: Harness | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.terminate();
  }

  await harness?.cleanup();
  harness = undefined;
});

const isEventOf = <E extends EventName>(
  event: RpcEvent,
  name: E
): event is RpcEvent & {
  readonly name: E;
  readonly payload: EventPayload<E>;
} => event.name === name;

const isResultOf = <M extends MethodName>(
  response: RpcResult,
  method: M
): response is RpcResult & { readonly result: MethodResult<M> } =>
  response.method === method;

/** Opens `/ws` with `origin`, greets the daemon, and subscribes to every event. */
const openDashboard = async (
  wsUrl: string,
  origin: string
): Promise<DashboardSession> => {
  const socket = new WebSocket(wsUrl, { origin });
  const pending = new Map<RpcId, Pending>();
  const events: RpcEvent[] = [];
  let nextId = 1;

  sockets.push(socket);
  socket.on("message", (data) => {
    const text = Buffer.isBuffer(data) ? data.toString("utf-8") : "";
    const message = decodeServerMessage(text, (id) => pending.get(id)?.method);

    if (message.kind === "event") {
      events.push(message.event);

      return;
    }

    if (message.kind === "result") {
      pending.get(message.response.id)?.settle(message.response);
      pending.delete(message.response.id);

      return;
    }

    if (message.kind === "error" && message.id !== null) {
      const { code, data: errorData, message: reason } = message.error;

      pending.get(message.id)?.settle(new RpcError(code, reason, errorData));
      pending.delete(message.id);
    }
  });
  await once(socket, "open");

  const request = async <M extends MethodName>(
    method: M,
    params: MethodParams<M>
  ): Promise<MethodResult<M>> => {
    const id = nextId;

    nextId += 1;

    const response = Promise.withResolvers<RpcResult | RpcError>();

    pending.set(id, { method, settle: response.resolve });
    socket.send(encodeRequest(id, method, params));

    const settled = await response.promise;

    if (settled instanceof RpcError) {
      throw settled;
    }

    if (!isResultOf(settled, method)) {
      throw new Error(`The daemon answered ${settled.method} for ${method}`);
    }

    return settled.result;
  };

  await request("system.hello", {
    client: { name: "wheatley-dashboard", version: "e2e" },
    protocolVersion: PROTOCOL_VERSION,
  });
  await request("events.subscribe", {});

  return {
    request,
    waitForEvent: async (name, predicate) =>
      await waitFor(
        () =>
          events.find(
            (
              event
            ): event is RpcEvent & {
              readonly payload: EventPayload<typeof name>;
            } =>
              isEventOf(event, name) &&
              (predicate === undefined || predicate(event.payload))
          )?.payload,
        `the dashboard event ${name}`
      ),
  };
};

/** Resolves the HTTP status of a WebSocket upgrade to `/ws`. Without `origin`, the request has no `Origin` header. */
const upgradeStatus = async (url: string, origin?: string): Promise<number> => {
  const socket = new WebSocket(url, origin === undefined ? {} : { origin });
  const { promise, resolve } = Promise.withResolvers<number>();

  socket.once("open", () => {
    socket.close();
    resolve(UPGRADE_OK);
  });
  socket.once("unexpected-response", (_request, response) => {
    resolve(response.statusCode ?? 0);
    socket.terminate();
  });
  socket.once("error", () => {
    resolve(0);
  });

  return await promise;
};

const exists = async (target: string): Promise<boolean> => {
  try {
    await stat(target);

    return true;
  } catch {
    return false;
  }
};

/** The text of every system message that the model received, which carries the Agent instructions. */
const systemText: (context: Parameters<FauxResponseFactory>[0]) => string = (
  context
) =>
  JSON.stringify(
    context.messages.filter((message) => message.role === "system")
  );

it("serves the dashboard SPA on / and accepts /ws only from its own or allowed origins", async () => {
  harness = await startHarness({
    config: { daemon: { allowedOrigins: [PROXY_ORIGIN] } },
    dashboardDir: FIXTURE_DIR,
  });

  const index = await readFile(path.join(FIXTURE_DIR, "index.html"), "utf-8");
  const page = await fetch(`${harness.httpUrl()}/`);

  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(await page.text()).toBe(index);

  const deepRoute = await fetch(`${harness.httpUrl()}/config/agents/home`);

  expect(deepRoute.status).toBe(200);
  expect(await deepRoute.text()).toBe(index);

  const script = await fetch(`${harness.httpUrl()}/assets/app.js`);

  expect(script.status).toBe(200);
  expect(script.headers.get("content-type")).toBe(
    "text/javascript; charset=utf-8"
  );
  expect(await script.text()).toContain("Wheatley dashboard fixture");

  const missingAsset = await fetch(`${harness.httpUrl()}/assets/missing.js`);

  expect(missingAsset.status).toBe(404);

  const { port } = new URL(harness.httpUrl());

  expect(await upgradeStatus(harness.wsUrl(), FOREIGN_ORIGIN)).toBe(
    UPGRADE_FORBIDDEN
  );
  expect(
    await upgradeStatus(harness.wsUrl(), `http://127.0.0.1:${port}0`)
  ).toBe(UPGRADE_FORBIDDEN);
  expect(await upgradeStatus(harness.wsUrl(), harness.httpUrl())).toBe(
    UPGRADE_OK
  );
  expect(await upgradeStatus(harness.wsUrl(), `http://localhost:${port}`)).toBe(
    UPGRADE_OK
  );
  expect(await upgradeStatus(harness.wsUrl(), PROXY_ORIGIN)).toBe(UPGRADE_OK);
  expect(await upgradeStatus(harness.wsUrl())).toBe(UPGRADE_OK);

  const dashboard = await openDashboard(harness.wsUrl(), harness.httpUrl());
  const status = await dashboard.request("system.status", {});

  expect(status.agents.map((agent) => [agent.name, agent.state])).toEqual([
    ["home", "running"],
  ]);
});

it("decides a Frontend Chat's Approval from the dashboard Approvals Inbox", async () => {
  harness = await startHarness({
    agents: {
      home: {
        frontends: [{ config: {}, id: "fake-main", type: "fake" }],
        permissionPolicy: [
          { action: "ask", tool: "write_file" },
          { action: "allow", tool: "*" },
        ],
      },
    },
    dashboardDir: FIXTURE_DIR,
  });

  const dashboard = await openDashboard(harness.wsUrl(), harness.httpUrl());
  const binding = harness.frontend.binding("home", "fake-main");
  const target = path.join(harness.workspaceDir(), "inbox.txt");

  harness.llm.faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("write_file", {
          content: "approved from the dashboard",
          path: "inbox.txt",
        }),
      ],
      { stopReason: "toolUse" }
    ),
    fauxAssistantMessage("I wrote inbox.txt"),
  ]);
  await harness.frontend.send("home", "fake-main", "chat-1", "Write inbox.txt");

  const { approval } = await dashboard.waitForEvent("approval.requested");

  expect(approval).toMatchObject({
    agent: "home",
    chat: { bindingId: "fake-main", chatId: "chat-1" },
    toolName: "write_file",
  });
  expect(approval.inputPreview).toContain("inbox.txt");

  const inbox = await dashboard.request("approvals.list", {});

  expect(inbox.approvals.map((item) => item.approvalId)).toEqual([
    approval.approvalId,
  ]);
  await waitFor(
    () =>
      binding.deliveries.find(
        (delivery) =>
          delivery.kind === "approval_requested" &&
          delivery.approvalId === approval.approvalId
      ),
    "the approval prompt in the Frontend Chat"
  );
  expect(await exists(target)).toBe(false);

  const decided = await dashboard.request("approvals.decide", {
    agent: "home",
    approvalId: approval.approvalId,
    resolution: { decision: "allow_always", resolvedBy: "Dashboard" },
  });

  expect(decided).toEqual({ accepted: true });
  await expect(
    harness.frontend.decide(
      "home",
      "fake-main",
      "chat-1",
      approval.approvalId,
      {
        decision: "deny",
      }
    )
  ).resolves.toBe(false);

  const resolved = await dashboard.waitForEvent(
    "approval.resolved",
    (payload) => payload.approvalId === approval.approvalId
  );

  expect(resolved).toMatchObject({
    agent: "home",
    decision: "allow_always",
    resolvedBy: "Dashboard",
  });

  const reply = await waitFor(
    () => binding.deliveries.find((delivery) => delivery.kind === "message"),
    "the reply after the Approval"
  );

  expect(reply).toMatchObject({ chatId: "chat-1", text: "I wrote inbox.txt" });
  expect(await readFile(target, "utf-8")).toBe("approved from the dashboard");
  expect(binding.deliveries).toContainEqual(
    expect.objectContaining({
      approvalId: approval.approvalId,
      decision: "allow_always",
      kind: "approval_resolved",
    })
  );
  await expect(dashboard.request("approvals.list", {})).resolves.toEqual({
    approvals: [],
  });

  const { config } = await dashboard.request("config.get", {});

  expect(config.agents.home?.permissionPolicy?.[0]).toEqual({
    action: "allow",
    tool: "write_file",
  });
});

it("saves config with expectedRevision, reports a conflict, and applies Save & Restart", async () => {
  harness = await startHarness({
    agents: {
      home: { frontends: [{ config: {}, id: "fake-main", type: "fake" }] },
    },
    dashboardDir: FIXTURE_DIR,
  });

  const dashboard = await openDashboard(harness.wsUrl(), harness.httpUrl());
  const configFile = path.join(harness.homeDir, "config.yaml");
  const loaded = await dashboard.request("config.get", {});

  // Another editor changes the file after the dashboard loaded it.
  await writeFile(configFile, `# Edited in a text editor\n${loaded.raw}`);

  const reloaded = await dashboard.request("config.get", {});
  const { home } = loaded.config.agents;

  if (home === undefined) {
    throw new Error("config.yaml has no home Agent");
  }

  const withInstructions = (instructions: string): DeploymentConfig => ({
    ...loaded.config,
    agents: { ...loaded.config.agents, home: { ...home, instructions } },
  });

  expect(reloaded.revision).not.toBe(loaded.revision);
  await expect(
    dashboard.request("config.save", {
      config: withInstructions("You are Wheatley v2."),
      expectedRevision: loaded.revision,
      restart: "affected",
    })
  ).rejects.toMatchObject({
    code: RpcErrorCode.RevisionConflict,
    data: { revision: reloaded.revision },
  });
  expect(await readFile(configFile, "utf-8")).not.toContain("Wheatley v2");

  const saved = await dashboard.request("config.save", {
    config: withInstructions("You are Wheatley v2."),
    expectedRevision: reloaded.revision,
    restart: "none",
  });

  expect(saved.pendingRestart).toEqual([{ agent: "home", kind: "agent" }]);
  await expect(
    dashboard.waitForEvent(
      "config.changed",
      (payload) => payload.revision === saved.revision
    )
  ).resolves.toEqual({
    pendingRestart: [{ agent: "home", kind: "agent" }],
    revision: saved.revision,
  });

  const savedText = await readFile(configFile, "utf-8");

  expect(savedText).toContain("# Edited in a text editor");
  expect(savedText).toContain("You are Wheatley v2.");
  await expect(
    dashboard.request("agents.get", { agent: "home" })
  ).resolves.toMatchObject({ pendingRestart: true, state: "running" });

  const restarted = await dashboard.request("config.save", {
    config: withInstructions("You are Wheatley v3."),
    expectedRevision: saved.revision,
    restart: "affected",
  });

  expect(restarted.pendingRestart).toEqual([]);

  const health = await waitFor(async () => {
    const current = await dashboard.request("agents.get", { agent: "home" });

    return current.state === "running" ? current : undefined;
  }, "the home Agent to run again");

  expect(health.pendingRestart).toBe(false);
  await expect(dashboard.request("config.get", {})).resolves.toMatchObject({
    pendingRestart: [],
    revision: restarted.revision,
  });

  const prompts: string[] = [];

  harness.llm.faux.setResponses([
    (context) => {
      prompts.push(systemText(context));

      return fauxAssistantMessage("Running with the new instructions");
    },
  ]);
  await harness.frontend.send("home", "fake-main", "chat-2", "Who are you?");

  const binding = harness.frontend.binding("home", "fake-main");

  await waitFor(
    () =>
      binding.deliveries.find(
        (delivery) =>
          delivery.kind === "message" && delivery.chatId === "chat-2"
      ),
    "the reply after Save & Restart"
  );
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("You are Wheatley v3.");
});

it("creates, renames, and deletes an Agent over JSON-RPC", async () => {
  harness = await startHarness({ dashboardDir: FIXTURE_DIR });

  const h = harness;
  const dashboard = await openDashboard(h.wsUrl(), h.httpUrl());
  const initial = await dashboard.request("config.get", {});

  const workConfig: AgentConfig = {
    model: { id: h.llm.modelId, provider: FAKE_PROVIDER },
    permissionPolicy: [...ALLOW_ALL],
  };

  await expect(
    dashboard.request("agents.create", {
      agent: "work",
      config: workConfig,
      expectedRevision: "stale-revision",
    })
  ).rejects.toMatchObject({
    code: RpcErrorCode.RevisionConflict,
    data: { revision: initial.revision },
  });
  await expect(
    dashboard.request("agents.create", {
      agent: "home",
      config: workConfig,
      expectedRevision: initial.revision,
    })
  ).rejects.toMatchObject({ code: RpcErrorCode.Conflict });

  const created = await dashboard.request("agents.create", {
    agent: "work",
    config: workConfig,
    expectedRevision: initial.revision,
  });

  await waitFor(async () => {
    const health = await dashboard.request("agents.get", { agent: "work" });

    return health.state === "running" ? true : undefined;
  }, "the work Agent to run");
  expect(await exists(path.join(h.agentDir("work"), "harness.sqlite"))).toBe(
    true
  );
  expect(await exists(path.join(h.agentDir("work"), "agent.sqlite"))).toBe(
    true
  );

  const listed = await dashboard.request("agents.list", {});

  expect(listed.agents.map((agent) => agent.name)).toEqual(["home", "work"]);

  h.llm.faux.setResponses([fauxAssistantMessage("Work Agent here")]);

  const sent = await dashboard.request("chat.send", {
    agent: "work",
    text: "Hello work",
  });

  await dashboard.waitForEvent(
    "chat.message",
    (payload) =>
      payload.agent === "work" &&
      payload.message.messageId !== sent.messageId &&
      payload.message.role === "assistant" &&
      payload.message.text === "Work Agent here"
  );

  await expect(
    dashboard.request("agents.rename", {
      agent: "work",
      expectedRevision: created.revision,
      newName: "home",
    })
  ).rejects.toMatchObject({ code: RpcErrorCode.Conflict });

  const renamed = await dashboard.request("agents.rename", {
    agent: "work",
    expectedRevision: created.revision,
    newName: "office",
  });

  await waitFor(async () => {
    const health = await dashboard.request("agents.get", { agent: "office" });

    return health.state === "running" ? true : undefined;
  }, "the office Agent to run");
  await expect(
    dashboard.request("agents.get", { agent: "work" })
  ).rejects.toMatchObject({ code: RpcErrorCode.AgentNotFound });
  expect(await exists(h.agentDir("work"))).toBe(false);
  expect(await exists(path.join(h.agentDir("office"), "agent.sqlite"))).toBe(
    true
  );

  const history = await dashboard.request("chat.history", { agent: "office" });

  expect(
    history.messages.map((message) => [message.role, message.text])
  ).toEqual([
    ["user", "Hello work"],
    ["assistant", "Work Agent here"],
  ]);

  const afterRename = await dashboard.request("config.get", {});

  expect(Object.keys(afterRename.config.agents).toSorted()).toEqual([
    "home",
    "office",
  ]);
  expect(afterRename.revision).toBe(renamed.revision);

  await expect(
    dashboard.request("agents.delete", {
      agent: "office",
      data: "archive",
      expectedRevision: created.revision,
    })
  ).rejects.toMatchObject({ code: RpcErrorCode.RevisionConflict });

  const deleted = await dashboard.request("agents.delete", {
    agent: "office",
    data: "archive",
    expectedRevision: renamed.revision,
  });

  const afterDelete = await dashboard.request("agents.list", {});

  expect(afterDelete.agents.map((agent) => agent.name)).toEqual(["home"]);
  expect(await exists(h.agentDir("office"))).toBe(false);

  const archived = await readFile(path.join(h.homeDir, "config.yaml"), "utf-8");

  expect(archived).not.toContain("office");
  await expect(dashboard.request("config.get", {})).resolves.toMatchObject({
    revision: deleted.revision,
  });

  const archive = await readdir(path.join(h.homeDir, "archive"));

  expect(archive).toHaveLength(1);
  expect(archive[0]).toMatch(/^office-/u);
  await expect(
    dashboard.request("agents.get", { agent: "office" })
  ).rejects.toMatchObject({ code: RpcErrorCode.AgentNotFound });
});
