import { RpcError, RpcErrorCode } from "@wheatley/protocol";
import { afterEach, expect, test, vi } from "vitest";

import { startMockDaemon } from "../../mock/server.js";
import type { ListeningMockDaemon } from "../../mock/server.js";
import { createRpcClient, dashboardSocketUrl } from "./client.js";
import type { RpcClient } from "./client.js";

const opened: { daemon: ListeningMockDaemon; client: RpcClient }[] = [];

afterEach(async () => {
  const current = opened.splice(0);

  for (const { client } of current) {
    client.close();
  }

  await Promise.all(
    current.map(async ({ daemon }) => {
      await daemon.close();
    })
  );
});

const setup = async (): Promise<{
  daemon: ListeningMockDaemon;
  client: RpcClient;
}> => {
  const daemon = await startMockDaemon();

  const client = createRpcClient({
    clientName: "dashboard-test",
    clientVersion: "1.0.0",
    maxReconnectDelayMs: 20,
    reconnectDelayMs: 5,
    url: daemon.url,
  });

  opened.push({ client, daemon });

  return { client, daemon };
};

const waitForOpen = async (
  client: RpcClient,
  connection = 1
): Promise<void> => {
  await vi.waitFor(() => {
    expect(client.state.get()).toMatchObject({ connection, status: "open" });
  });
};

test("derives the socket URL from the page origin", () => {
  expect(dashboardSocketUrl(new URL("http://127.0.0.1:7420/#/inbox"))).toBe(
    "ws://127.0.0.1:7420/ws"
  );
  expect(dashboardSocketUrl(new URL("https://wheatley.example/"))).toBe(
    "wss://wheatley.example/ws"
  );
});

test("performs the hello and subscribe handshake before it reports open", async () => {
  const { client, daemon } = await setup();

  expect(client.state.get().status).toBe("connecting");

  client.connect();
  await waitForOpen(client);

  expect(daemon.received.slice(0, 2)).toEqual([
    "system.hello",
    "events.subscribe",
  ]);
  expect(client.state.get()).toMatchObject({
    lastError: null,
    pending: 0,
    wheatleyVersion: daemon.state.wheatleyVersion,
  });
});

test("queues calls made before the handshake and resolves validated results", async () => {
  const { client } = await setup();
  const result = client.call("agents.list", {});

  client.connect();

  const { agents } = await result;

  expect(agents.map((agent) => agent.name)).toEqual(["home", "work"]);
  expect(client.state.get().pending).toBe(0);
});

test("rejects with an RpcError that keeps the code and data of the error response", async () => {
  const { client, daemon } = await setup();

  client.connect();

  const saving = client.call("config.save", {
    expectedRevision: "rev-0",
    raw: "version: 1\n",
  });

  await expect(saving).rejects.toBeInstanceOf(RpcError);
  await expect(saving).rejects.toMatchObject({
    code: RpcErrorCode.RevisionConflict,
    data: { revision: `rev-${daemon.state.revision}` },
  });
});

test("settles a request before it dispatches the events that the request caused", async () => {
  const { client } = await setup();
  const pendingAtEvent: number[] = [];

  client.on("chat.message", () => {
    pendingAtEvent.push(client.state.get().pending);
  });
  client.connect();
  await waitForOpen(client);

  const result = await client.call("chat.send", { agent: "home", text: "hi" });

  await vi.waitFor(() => {
    expect(pendingAtEvent).toHaveLength(2);
  });

  expect(result.messageId).not.toBe("");
  expect(pendingAtEvent).toEqual([0, 0]);
});

test("stops calling a listener after it unsubscribes", async () => {
  const { client, daemon } = await setup();
  const seen: string[] = [];

  const off = client.on("agent.status", ({ state }) => {
    seen.push(state);
  });

  client.connect();
  await waitForOpen(client);
  await client.call("agents.stop", { agent: "work" });
  await vi.waitFor(() => {
    expect(seen).toEqual(["stopped"]);
  });

  off();
  daemon.emit("agent.status", { agent: "work", state: "running" });
  await client.call("agents.list", {});

  expect(seen).toEqual(["stopped"]);
});

test("rejects pending calls on a lost connection, then reconnects and signals ready again", async () => {
  const { client, daemon } = await setup();
  let readyCount = 0;

  client.onReady(() => {
    readyCount += 1;
  });
  client.connect();
  await waitForOpen(client);

  daemon.override("agents.list", () => {
    daemon.dropConnections();

    return { agents: [] };
  });

  await expect(client.call("agents.list", {})).rejects.toThrow(
    "The daemon connection closed"
  );

  await waitForOpen(client, 2);

  expect(readyCount).toBe(2);
  expect(client.state.get().pending).toBe(0);
});

test("stops at an incompatible protocol version and rejects calls", async () => {
  const { client, daemon } = await setup();

  daemon.override("system.hello", () => {
    throw new RpcError(RpcErrorCode.ProtocolMismatch, "Protocol 2 required");
  });

  const waiting = client.call("agents.list", {});

  client.connect();

  await expect(waiting).rejects.toThrow("Protocol 2 required");
  expect(client.state.get()).toMatchObject({
    lastError: "Protocol 2 required",
    status: "incompatible",
  });
  await expect(client.call("agents.list", {})).rejects.toThrow(
    "Protocol 2 required"
  );
});

test("rejects calls after close", async () => {
  const { client } = await setup();

  client.connect();
  await waitForOpen(client);
  client.close();

  expect(client.state.get().status).toBe("closed");
  await expect(client.call("agents.list", {})).rejects.toThrow(
    "The dashboard closed its daemon connection"
  );
});
