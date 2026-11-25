// Flow 6: the live dashboard that the daemon serves on `/` and `/ws`. The suite builds the real dashboard SPA with Vite
// and bundles it as `npm pack` does. The daemon serves that bundle. The dashboard's own JSON-RPC client and view models
// drive the Approvals Inbox, the Config editor with Save & Restart, and Agent create, rename, and delete.
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { FauxResponseFactory } from "@earendil-works/pi-ai";
import { RpcErrorCode } from "@wheatley/protocol";
import type { AgentConfig, EventName, EventPayload } from "@wheatley/protocol";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { WebSocket } from "ws";

import { createConfigEditor } from "../../../dashboard/src/models/config-editor.js";
import type {
  ConfigChange,
  ConfigEditor,
} from "../../../dashboard/src/models/config-editor.js";
import {
  createInbox,
  OPERATOR_DISPLAY_NAME,
} from "../../../dashboard/src/models/inbox.js";
import {
  createRpcClient,
  dashboardSocketUrl,
} from "../../../dashboard/src/rpc/client.js";
import type { RpcClient } from "../../../dashboard/src/rpc/client.js";
import { FAKE_PROVIDER } from "../../src/core/test-support.js";
import { bundleDashboardAssets } from "../../src/ops/dashboard-assets.js";
import { startHarness, waitFor } from "./harness.js";
import type { Harness } from "./harness.js";

const DASHBOARD_PACKAGE = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "dashboard"
);

const VITE_BIN = path.join(
  DASHBOARD_PACKAGE,
  "node_modules",
  "vite",
  "bin",
  "vite.js"
);

/** The script and stylesheet references of the built `index.html`. */
const ASSET_REFERENCE = /(?:src|href)="(?<asset>\/assets\/[^"]+)"/gu;

const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
]);

/** An origin that `daemon.allowedOrigins` lists, for example a dashboard behind a reverse proxy. */
const PROXY_ORIGIN = "http://dashboard.example:8080";

const FOREIGN_ORIGIN = "http://evil.example";

const UPGRADE_OK = 101;
const UPGRADE_FORBIDDEN = 403;

const ALLOW_ALL = [{ action: "allow", tool: "*" }] as const;

let workDir: string;
let dashboardDir: string;
let harness: Harness | undefined;
const clients: RpcClient[] = [];
const disposers: (() => void)[] = [];

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "wheatley-e2e-dashboard-"));

  const viteOut = path.join(workDir, "vite");

  dashboardDir = path.join(workDir, "bundled");
  execFileSync(
    process.execPath,
    [VITE_BIN, "build", "--outDir", viteOut, "--emptyOutDir"],
    { cwd: DASHBOARD_PACKAGE, stdio: "pipe" }
  );
  await bundleDashboardAssets(viteOut, dashboardDir);
});

afterAll(async () => {
  await rm(workDir, { force: true, recursive: true });
});

afterEach(async () => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }

  for (const client of clients.splice(0)) {
    client.close();
  }

  await harness?.cleanup();
  harness = undefined;
});

/** Connects the dashboard's own JSON-RPC client to the `/ws` URL that the served page derives from its location. */
const connectDashboard = async (h: Harness): Promise<RpcClient> => {
  const client = createRpcClient({
    clientName: "wheatley-dashboard",
    clientVersion: "e2e",
    url: dashboardSocketUrl(new URL(h.httpUrl())),
  });

  clients.push(client);
  client.connect();
  // A call waits for the handshake: `system.hello` and `events.subscribe` for every topic.
  await client.call("system.status", {});

  return client;
};

/** Resolves with the next `name` event that matches `predicate`. Register it before the action that causes it. */
const nextEvent = async <E extends EventName>(
  client: RpcClient,
  name: E,
  predicate: (payload: EventPayload<E>) => boolean = () => true
): Promise<EventPayload<E>> => {
  const { promise, resolve } = Promise.withResolvers<EventPayload<E>>();

  const off = client.on(name, (payload) => {
    if (predicate(payload)) {
      off();
      resolve(payload);
    }
  });

  return await promise;
};

/** A Config editor that the test disposes, loaded once. */
const loadedEditor = async (client: RpcClient): Promise<ConfigEditor> => {
  const editor = createConfigEditor(client);

  disposers.push(editor.dispose);
  await waitFor(
    () => editor.state.get().revision ?? undefined,
    "the Config editor to load config.yaml"
  );

  return editor;
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

const waitForRunning = async (
  client: RpcClient,
  agent: string
): Promise<void> => {
  await waitFor(async () => {
    const health = await client.call("agents.get", { agent });

    return health.state === "running" ? true : undefined;
  }, `the ${agent} Agent to run`);
};

/** The text of every system message that the model received, which carries the Agent instructions. */
const systemText: (context: Parameters<FauxResponseFactory>[0]) => string = (
  context
) =>
  JSON.stringify(
    context.messages.filter((message) => message.role === "system")
  );

it("serves the built dashboard SPA on / and accepts /ws only from its own or allowed origins", async () => {
  harness = await startHarness({
    config: { daemon: { allowedOrigins: [PROXY_ORIGIN] } },
    dashboardDir,
  });

  const index = await readFile(path.join(dashboardDir, "index.html"), "utf-8");
  const page = await fetch(`${harness.httpUrl()}/`);

  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(await page.text()).toBe(index);

  const deepRoute = await fetch(`${harness.httpUrl()}/config/agents/home`);

  expect(deepRoute.status).toBe(200);
  expect(await deepRoute.text()).toBe(index);

  const assets = [...index.matchAll(ASSET_REFERENCE)].map(
    (match) => match.groups?.asset ?? ""
  );

  expect(assets.map((asset) => path.extname(asset)).toSorted()).toEqual([
    ".css",
    ".js",
  ]);

  for (const asset of assets) {
    // oxlint-disable-next-line no-await-in-loop -- The page loads two assets, one after the other.
    const response = await fetch(`${harness.httpUrl()}${asset}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      CONTENT_TYPES.get(path.extname(asset))
    );
    // oxlint-disable-next-line no-await-in-loop -- See above.
    expect(await response.text()).toBe(
      // oxlint-disable-next-line no-await-in-loop -- See above.
      await readFile(path.join(dashboardDir, asset), "utf-8")
    );
  }

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

  const client = await connectDashboard(harness);
  const status = await client.call("system.status", {});

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
    dashboardDir,
  });

  const client = await connectDashboard(harness);
  const inbox = createInbox(client);

  disposers.push(inbox.dispose);

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

  const approval = await waitFor(
    () => inbox.state.get().approvals[0],
    "the Approval in the dashboard Inbox"
  );

  expect(inbox.state.get().approvals).toHaveLength(1);
  expect(approval).toMatchObject({
    agent: "home",
    chat: { bindingId: "fake-main", chatId: "chat-1" },
    toolName: "write_file",
  });
  expect(approval.inputPreview).toContain("inbox.txt");
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

  const resolved = nextEvent(
    client,
    "approval.resolved",
    (payload) => payload.approvalId === approval.approvalId
  );

  await inbox.decide(approval, "allow_always");

  expect(inbox.state.get()).toMatchObject({
    approvals: [],
    itemErrors: new Map(),
    notice: null,
  });
  await expect(resolved).resolves.toMatchObject({
    agent: "home",
    decision: "allow_always",
    resolvedBy: OPERATOR_DISPLAY_NAME,
  });
  await expect(
    harness.frontend.decide(
      "home",
      "fake-main",
      "chat-1",
      approval.approvalId,
      { decision: "deny" }
    )
  ).resolves.toBe(false);

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

  await inbox.refresh();
  expect(inbox.state.get().approvals).toEqual([]);

  const { config } = await client.call("config.get", {});

  expect(config.agents.home?.permissionPolicy?.[0]).toEqual({
    action: "allow",
    tool: "write_file",
  });
});

it("reports a revision conflict in the Config editor, overwrites it, and applies Save & Restart", async () => {
  harness = await startHarness({
    agents: {
      home: { frontends: [{ config: {}, id: "fake-main", type: "fake" }] },
    },
    dashboardDir,
  });

  const client = await connectDashboard(harness);
  const editor = await loadedEditor(client);
  const configFile = path.join(harness.homeDir, "config.yaml");
  const loaded = editor.state.get();
  const home = loaded.config?.agents.home;

  if (home === undefined) {
    throw new Error("config.yaml has no home Agent");
  }

  const instructionsChange = (
    instructions: string,
    restart: "none" | "affected"
  ): ConfigChange => ({
    agent: "home",
    config: { ...home, instructions },
    kind: "agent",
    restart,
  });

  // Another editor changes the file after the dashboard loaded it.
  await writeFile(configFile, `# Edited in a text editor\n${loaded.raw}`);

  const current = await client.call("config.get", {});

  expect(current.revision).not.toBe(loaded.revision);
  await expect(
    editor.save(instructionsChange("You are Wheatley v2.", "none"))
  ).resolves.toBe(false);
  expect(editor.state.get().conflict).toEqual({
    change: instructionsChange("You are Wheatley v2.", "none"),
    currentRevision: current.revision,
  });
  expect(await readFile(configFile, "utf-8")).not.toContain("Wheatley v2");

  await expect(editor.resolveConflict("overwrite")).resolves.toBe(true);

  const saved = editor.state.get();

  expect(saved).toMatchObject({
    conflict: null,
    pendingRestart: [{ agent: "home", kind: "agent" }],
    saveError: null,
  });

  const savedText = await readFile(configFile, "utf-8");

  expect(savedText).toContain("# Edited in a text editor");
  expect(savedText).toContain("You are Wheatley v2.");
  await expect(
    client.call("agents.get", { agent: "home" })
  ).resolves.toMatchObject({ pendingRestart: true, state: "running" });

  await expect(
    editor.save(instructionsChange("You are Wheatley v3.", "affected"))
  ).resolves.toBe(true);
  expect(editor.state.get().pendingRestart).toEqual([]);

  const health = await waitFor(async () => {
    const agent = await client.call("agents.get", { agent: "home" });

    return agent.state === "running" ? agent : undefined;
  }, "the home Agent to run again");

  expect(health.pendingRestart).toBe(false);

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

it("creates, renames, and deletes an Agent from the Config editor", async () => {
  harness = await startHarness({ dashboardDir });

  const h = harness;
  const client = await connectDashboard(h);
  const editor = await loadedEditor(client);

  const workConfig: AgentConfig = {
    model: { id: h.llm.modelId, provider: FAKE_PROVIDER },
    permissionPolicy: [...ALLOW_ALL],
  };

  await expect(
    editor.save({ agent: "home", config: workConfig, kind: "create" })
  ).resolves.toBe(false);
  expect(editor.state.get().saveError).not.toBeNull();

  // A hand edit after the load makes the create conflict. The Operator overwrites.
  const configFile = path.join(h.homeDir, "config.yaml");

  await writeFile(
    configFile,
    `# Edited in a text editor\n${editor.state.get().raw}`
  );
  await expect(
    editor.save({ agent: "work", config: workConfig, kind: "create" })
  ).resolves.toBe(false);
  expect(editor.state.get().conflict?.change).toMatchObject({
    agent: "work",
    kind: "create",
  });
  await expect(editor.resolveConflict("overwrite")).resolves.toBe(true);
  await waitForRunning(client, "work");

  const listed = await client.call("agents.list", {});

  expect(listed.agents.map((agent) => agent.name)).toEqual(["home", "work"]);

  h.llm.faux.setResponses([fauxAssistantMessage("Work Agent here")]);

  const answered = nextEvent(
    client,
    "chat.message",
    (payload) =>
      payload.agent === "work" &&
      payload.message.role === "assistant" &&
      payload.message.text === "Work Agent here"
  );

  await client.call("chat.send", { agent: "work", text: "Hello work" });
  await answered;

  await expect(
    editor.save({ agent: "work", kind: "rename", newName: "home" })
  ).resolves.toBe(false);
  expect(editor.state.get().saveError).not.toBeNull();
  await expect(
    editor.save({ agent: "work", kind: "rename", newName: "office" })
  ).resolves.toBe(true);
  await waitForRunning(client, "office");
  await expect(
    client.call("agents.get", { agent: "work" })
  ).rejects.toMatchObject({ code: RpcErrorCode.AgentNotFound });

  const history = await client.call("chat.history", { agent: "office" });

  expect(
    history.messages.map((message) => [message.role, message.text])
  ).toEqual([
    ["user", "Hello work"],
    ["assistant", "Work Agent here"],
  ]);
  expect(
    Object.keys(editor.state.get().config?.agents ?? {}).toSorted()
  ).toEqual(["home", "office"]);

  await expect(
    editor.save({ agent: "office", data: "archive", kind: "delete" })
  ).resolves.toBe(true);

  const afterDelete = await client.call("agents.list", {});

  expect(afterDelete.agents.map((agent) => agent.name)).toEqual(["home"]);
  expect(await readFile(configFile, "utf-8")).not.toContain("office");
  expect(editor.state.get().config?.agents).not.toHaveProperty("office");

  const archive = await readdir(path.join(h.homeDir, "archive"));

  expect(archive).toHaveLength(1);
  expect(archive[0]).toMatch(/^office-/u);
  await expect(
    client.call("agents.get", { agent: "office" })
  ).rejects.toMatchObject({ code: RpcErrorCode.AgentNotFound });
});
