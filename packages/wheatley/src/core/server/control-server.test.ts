import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { encodeRequest, RpcError, RpcErrorCode } from "@wheatley-ai/protocol";
import type { RpcEvent } from "@wheatley-ai/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { RawData } from "ws";

import { DaemonClient } from "../../cli/client.js";
import { startDaemon } from "../daemon.js";
import type { Daemon } from "../daemon.js";
import {
  builtinCatalog,
  createFakeLlm,
  FAKE_PROVIDER,
  temporaryDir,
} from "../test-support.js";
import type { FakeLlm } from "../test-support.js";
import { isLoopbackHost } from "./control-server.js";

let home: Awaited<ReturnType<typeof temporaryDir>>;
let llm: FakeLlm;
let daemon: Daemon;
const clients: DaemonClient[] = [];

/** Each Agent start waits for this promise before it builds its models. */
let modelsReady: Promise<unknown>;

/** If set, each Agent start fails with this error. */
let modelsFailure: Error | undefined;

const connect = async (): Promise<DaemonClient> => {
  const client = await DaemonClient.connect({ url: daemon.server.url }, "test");

  clients.push(client);

  return client;
};

const textOf = (data: RawData): string =>
  Array.isArray(data)
    ? Buffer.concat(data).toString("utf-8")
    : Buffer.from(
        data instanceof ArrayBuffer ? new Uint8Array(data) : data
      ).toString("utf-8");

interface WireMessage {
  readonly id?: number;
  readonly method?: string;
  readonly error?: { readonly code: number };
}

const isWireMessage = (value: unknown): value is WireMessage =>
  typeof value === "object" && value !== null;

const wireMessage = (data: RawData): WireMessage => {
  const value: unknown = JSON.parse(textOf(data));

  if (!isWireMessage(value)) {
    throw new Error("The daemon sent a message that is not an object");
  }

  return value;
};

/** Restarts `alpha` over JSON-RPC and resolves once the new start waits for `release`. */
const restartHeldAlpha = async (client: DaemonClient) => {
  const hold = Promise.withResolvers<undefined>();

  modelsReady = hold.promise;

  const restarted = client.request("agents.restart", { agent: "alpha" });

  await vi.waitFor(async () => {
    const status = await client.request("system.status", {});

    expect(status.agents.find((agent) => agent.name === "alpha")?.state).toBe(
      "starting"
    );
  });

  return {
    release: () => {
      hold.resolve(undefined);
    },
    restarted,
  };
};

const rpcCode = async (
  promise: Promise<unknown>
): Promise<number | undefined> => {
  try {
    await promise;

    return undefined;
  } catch (error) {
    return error instanceof RpcError ? error.code : -1;
  }
};

/** Opens a raw WebSocket and resolves with the HTTP status of a refused upgrade, or 101. */
const upgradeStatus = async (
  headers: Readonly<Record<string, string>>
): Promise<number> => {
  const socket = new WebSocket(daemon.server.url, { headers });
  const status = Promise.withResolvers<number>();

  socket.once("open", () => {
    status.resolve(101);
    socket.close();
  });
  socket.once("unexpected-response", (_request, response) => {
    status.resolve(response.statusCode ?? 0);
  });
  socket.once("error", () => {
    status.resolve(0);
  });

  return await status.promise;
};

beforeEach(async () => {
  modelsReady = Promise.resolve();
  modelsFailure = undefined;
  home = await temporaryDir();
  llm = createFakeLlm();
  await writeFile(
    path.join(home.dir, "config.yaml"),
    [
      "version: 1",
      "daemon:",
      "  allowedOrigins: ['https://dashboard.example']",
      "agents:",
      ...["alpha", "beta"].flatMap((name) => [
        `  ${name}:`,
        `    model: ${FAKE_PROVIDER}/${llm.modelId}`,
      ]),
      "",
    ].join("\n")
  );
  daemon = await startDaemon({
    env: {},
    extensions: builtinCatalog(),
    homeDir: home.dir,
    models: async () => {
      await modelsReady;

      if (modelsFailure !== undefined) {
        throw modelsFailure;
      }

      return llm.models;
    },
    port: 0,
    socketPath: null,
    version: "test",
  });
});

afterEach(async () => {
  await Promise.all(
    clients.splice(0).map(async (client) => {
      await client.close();
    })
  );
  await daemon.close();
  await home.remove();
});

describe("ControlServer", () => {
  it("counts only loopback hosts as local", () => {
    expect(
      ["localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]"].map(
        isLoopbackHost
      )
    ).toStrictEqual([true, true, true, true, true]);
    expect(
      ["0.0.0.0", "::", "192.168.1.10", "example.com", "127.example.com"].map(
        isLoopbackHost
      )
    ).toStrictEqual([false, false, false, false, false]);
  });

  it("accepts its own origin and listed origins and refuses foreign browser origins", async () => {
    const own = new URL(daemon.server.url);

    await expect(upgradeStatus({})).resolves.toBe(101);
    await expect(
      upgradeStatus({ origin: `http://localhost:${own.port}` })
    ).resolves.toBe(101);
    await expect(
      upgradeStatus({ origin: "https://dashboard.example" })
    ).resolves.toBe(101);
    await expect(
      upgradeStatus({ origin: "https://evil.example" })
    ).resolves.toBe(403);
  });

  it("requires system.hello first and refuses another protocol version", async () => {
    const socket = new WebSocket(daemon.server.url);

    await once(socket, "open");

    const replies: WireMessage[] = [];

    socket.on("message", (data) => {
      replies.push(wireMessage(data));
    });
    socket.send(encodeRequest(1, "agents.list", {}));
    socket.send(
      encodeRequest(2, "system.hello", {
        client: { name: "old", version: "0" },
        protocolVersion: 99,
      })
    );
    await vi.waitFor(() => {
      expect(replies).toHaveLength(2);
    });
    socket.close();

    expect(replies.map((reply) => reply.error?.code)).toStrictEqual([
      RpcErrorCode.InvalidRequest,
      RpcErrorCode.ProtocolMismatch,
    ]);
  });

  it("answers a request before the events that it causes, and broadcasts to every subscribed connection", async () => {
    llm.faux.setResponses([fauxAssistantMessage("hi there")]);

    const sender = new WebSocket(daemon.server.url);

    await once(sender, "open");

    const watcher = await connect();
    const order: string[] = [];
    const watched: RpcEvent[] = [];

    sender.on("message", (data) => {
      const message = wireMessage(data);

      order.push(message.method ?? `response ${message.id ?? "?"}`);
    });
    watcher.onEvent((event) => {
      watched.push(event);
    });
    await watcher.request("events.subscribe", { topics: ["chat"] });
    sender.send(
      encodeRequest(1, "system.hello", {
        client: { name: "raw", version: "0" },
        protocolVersion: 1,
      })
    );
    sender.send(
      encodeRequest(2, "events.subscribe", {
        agents: ["alpha"],
        topics: ["chat", "run"],
      })
    );
    sender.send(
      encodeRequest(3, "chat.send", { agent: "alpha", text: "hello" })
    );
    await vi.waitFor(() => {
      expect(order).toContain("run.finished");
    });
    sender.close();

    expect(order.slice(0, 5)).toStrictEqual([
      "response 1",
      "response 2",
      "response 3",
      "chat.message",
      "run.started",
    ]);
    expect(
      watched.map((event) =>
        event.name === "chat.message" ? event.payload.message.text : event.name
      )
    ).toStrictEqual(["hello", "hi there"]);
  });

  it("maps seam errors to JSON-RPC error codes and fans out runs.list over running Agents", async () => {
    const client = await connect();

    await expect(
      rpcCode(client.request("chat.history", { agent: "nobody" }))
    ).resolves.toBe(RpcErrorCode.AgentNotFound);
    await expect(
      rpcCode(client.request("runs.get", { agent: "alpha", runId: "missing" }))
    ).resolves.toBe(RpcErrorCode.NotFound);

    await client.request("agents.stop", { agent: "beta" });
    await expect(
      rpcCode(client.request("chat.history", { agent: "beta" }))
    ).resolves.toBe(RpcErrorCode.AgentUnavailable);

    llm.faux.setResponses([fauxAssistantMessage("done")]);
    await client.request("chat.send", { agent: "alpha", text: "hello" });
    await vi.waitFor(async () => {
      const { runs } = await client.request("runs.list", {});

      expect(runs.map((run) => [run.agent, run.status])).toStrictEqual([
        ["alpha", "completed"],
      ]);
    });
  });

  it("serves config, Agent lifecycle, and status through JSON-RPC", async () => {
    const client = await connect();
    const config = await client.request("config.get", {});

    expect(config.pendingRestart).toStrictEqual([]);

    const created = await client.request("agents.create", {
      agent: "gamma",
      config: { model: `${FAKE_PROVIDER}/${llm.modelId}` },
      expectedRevision: config.revision,
    });

    await expect(
      rpcCode(
        client.request("agents.create", {
          agent: "delta",
          config: { model: `${FAKE_PROVIDER}/${llm.modelId}` },
          expectedRevision: config.revision,
        })
      )
    ).resolves.toBe(RpcErrorCode.RevisionConflict);

    const status = await client.request("system.status", {});

    expect(
      status.agents.map((agent) => [agent.name, agent.state])
    ).toStrictEqual([
      ["alpha", "running"],
      ["beta", "running"],
      ["gamma", "running"],
    ]);
    expect(created.revision).not.toBe(config.revision);
  });

  it("holds chat.send to a restarting Agent and handles it once the Agent runs", async () => {
    const client = await connect();
    const { release, restarted } = await restartHeldAlpha(client);

    llm.faux.setResponses([fauxAssistantMessage("back again")]);

    const sent = client.request("chat.send", {
      agent: "alpha",
      text: "are you back?",
    });

    // The daemon starts the requests of one connection in arrival order, so chat.send waits by the time this answers.
    await client.request("system.status", {});
    release();

    await expect(restarted).resolves.toStrictEqual({ state: "running" });
    const { messageId } = await sent;

    expect(messageId).not.toBe("");
    await vi.waitFor(async () => {
      const history = await client.request("chat.history", { agent: "alpha" });

      expect(history.messages.map((message) => message.text)).toContain(
        "back again"
      );
    });
  });

  it("fails chat.send with agent_unavailable when the restart degrades the Agent, before the wait ends", async () => {
    const client = await connect();

    modelsFailure = new Error("The provider is down");
    const { release, restarted } = await restartHeldAlpha(client);

    const sent = rpcCode(
      client.request("chat.send", { agent: "alpha", text: "hello?" })
    );

    await client.request("system.status", {});
    release();

    await expect(restarted).resolves.toStrictEqual({ state: "degraded" });
    // The test timeout is shorter than AGENT_START_WAIT_MS, so the error does not come from the timeout.
    await expect(sent).resolves.toBe(RpcErrorCode.AgentUnavailable);
  });
});
