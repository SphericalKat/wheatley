// Flow 1 of issue #50: two Agents in one Deployment keep separate storage and state, share the Concurrency Gate of a
// provider credential, and a degraded Agent does not affect the other Agent.
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { FauxResponseFactory } from "@earendil-works/pi-ai";
import { RpcErrorCode } from "@wheatley/protocol";
import type { GatePressure, RunSummary } from "@wheatley/protocol";
import { afterEach, expect, it } from "vitest";

import { startHarness, waitFor } from "./harness.js";
import type { Harness, HarnessOptions, RpcSession } from "./harness.js";

const BINDING = "fake-main";
const FAKE_CREDENTIAL = "faux";
const HARNESS_FILE = "harness.sqlite";
const AGENT_DB_FILE = "agent.sqlite";
/** How long the test watches for a model request that must not start. */

const QUIET_MS = 300;

const withBinding = { frontends: [{ config: {}, id: BINDING, type: "fake" }] };

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

const start = async (options: HarnessOptions): Promise<Harness> => {
  harness = await startHarness(options);

  return harness;
};

/** A model response that repeats the last user message, so a reply shows which prompt it answered. */
const echo: FauxResponseFactory = (context) => {
  const lastUser = context.messages.findLast(
    (message) => message.role === "user"
  );

  // The content is a string or text blocks. Its JSON form contains the prompt text either way.
  return fauxAssistantMessage(
    `echo: ${JSON.stringify(lastUser?.content ?? "")}`
  );
};

const echoes = (count: number): FauxResponseFactory[] =>
  Array.from({ length: count }, () => echo);

/** Sends a one-shot prompt to `agent` over JSON-RPC and resolves with the finished Run. */
const ask = async (
  session: RpcSession,
  agent: string,
  text: string
): Promise<RunSummary> => {
  const { runId } = await session.request("chat.ask", {
    agent,
    interactive: false,
    text,
  });

  const finished = await session.waitForEvent(
    "run.finished",
    (payload) => payload.run.runId === runId
  );

  return finished.run;
};

const historyText = async (
  session: RpcSession,
  agent: string
): Promise<string> => {
  const history = await session.request("chat.history", { agent });

  return history.messages.map((message) => message.text).join("\n");
};

const isFile = async (target: string): Promise<boolean> => {
  try {
    const info = await stat(target);

    return info.isFile();
  } catch {
    return false;
  }
};

const fakePressure = async (
  session: RpcSession
): Promise<GatePressure | undefined> => {
  const status = await session.request("system.status", {});

  return status.concurrency.find(
    (pressure) => pressure.credential === FAKE_CREDENTIAL
  );
};

it("gives each Agent its own harness.sqlite, agent.sqlite, workspace, Chats, Runs, Memory, and Frontend Binding", async () => {
  const h = await start({ agents: { alpha: withBinding, beta: withBinding } });

  for (const agent of ["alpha", "beta"]) {
    // oxlint-disable-next-line no-await-in-loop -- Each Agent folder is checked in turn.
    await expect(
      isFile(path.join(h.agentDir(agent), HARNESS_FILE))
    ).resolves.toBe(true);
    // oxlint-disable-next-line no-await-in-loop -- Each Agent folder is checked in turn.
    await expect(
      isFile(path.join(h.agentDir(agent), AGENT_DB_FILE))
    ).resolves.toBe(true);
  }

  const session = await h.connect();
  const status = await session.request("system.status", {});

  expect(status.agents.map((agent) => [agent.name, agent.state])).toEqual([
    ["alpha", "running"],
    ["beta", "running"],
  ]);

  h.llm.faux.setResponses(echoes(2));
  const alphaRun = await ask(session, "alpha", "alpha-secret-1");
  const betaRun = await ask(session, "beta", "beta-secret-1");

  expect(alphaRun).toMatchObject({ agent: "alpha", status: "completed" });
  expect(betaRun).toMatchObject({ agent: "beta", status: "completed" });

  const alphaHistory = await historyText(session, "alpha");
  const betaHistory = await historyText(session, "beta");

  expect(alphaHistory).toMatch(/echo: .*alpha-secret-1/u);
  expect(alphaHistory).not.toContain("beta-secret-1");
  expect(betaHistory).toMatch(/echo: .*beta-secret-1/u);
  expect(betaHistory).not.toContain("alpha-secret-1");

  const alphaRuns = await session.request("runs.list", {
    agent: "alpha",
    status: "all",
  });

  const betaRuns = await session.request("runs.list", {
    agent: "beta",
    status: "all",
  });

  expect(alphaRuns.runs.map((run) => run.runId)).toEqual([alphaRun.runId]);
  expect(betaRuns.runs.map((run) => run.runId)).toEqual([betaRun.runId]);

  // A Tool of one Agent writes into that Agent's workspace only.
  h.llm.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("write_file", { content: "from alpha", path: "note.txt" }),
      { stopReason: "toolUse" }
    ),
    fauxAssistantMessage("Saved"),
  ]);
  const toolRun = await ask(session, "alpha", "Save a note");

  expect(toolRun.status).toBe("completed");
  await expect(
    isFile(path.join(h.workspaceDir("alpha"), "note.txt"))
  ).resolves.toBe(true);
  await expect(
    isFile(path.join(h.workspaceDir("beta"), "note.txt"))
  ).resolves.toBe(false);

  // Memory of one Agent is not visible to the other.
  await session.request("memory.write", {
    agent: "alpha",
    content: "alpha-memory-fact",
    name: "MEMORY",
  });

  const alphaMemory = await session.request("memory.read", {
    agent: "alpha",
    name: "MEMORY",
  });

  expect(alphaMemory.content).toContain("alpha-memory-fact");

  const betaMemory = await session.request("memory.list", { agent: "beta" });

  const betaContents = await Promise.all(
    betaMemory.files.map(
      async (file) =>
        await session.request("memory.read", { agent: "beta", name: file.name })
    )
  );

  expect(betaContents.map((file) => file.content).join("\n")).not.toContain(
    "alpha-memory-fact"
  );

  const betaHits = await session.request("memory.search", {
    agent: "beta",
    query: "alpha-memory-fact",
  });

  expect(betaHits.hits).toEqual([]);

  // A Frontend message to one Agent is delivered through that Agent's Binding only.
  h.llm.faux.setResponses(echoes(1));
  await h.frontend.send("alpha", BINDING, "chat-1", "alpha-frontend-hello");

  const alphaBinding = h.frontend.binding("alpha", BINDING);
  const betaBinding = h.frontend.binding("beta", BINDING);

  const reply = await waitFor(
    () =>
      alphaBinding.deliveries.find((delivery) => delivery.kind === "message"),
    "the alpha reply delivery"
  );

  expect(reply).toMatchObject({ chatId: "chat-1", kind: "message" });
  expect(reply.kind === "message" ? reply.text : "").toContain(
    "alpha-frontend-hello"
  );
  expect(betaBinding.deliveries).toEqual([]);
  expect(betaBinding.events).toEqual([]);
});

it("shares one Concurrency Gate slot of a provider credential between Agents", async () => {
  const h = await start({
    agents: { alpha: {}, beta: {} },
    config: { providers: { [FAKE_CREDENTIAL]: { maxConcurrent: 1 } } },
  });

  const session = await h.connect();
  const release = Promise.withResolvers<undefined>();

  h.llm.faux.setResponses([
    async () => {
      await release.promise;

      return fauxAssistantMessage("alpha done");
    },
    fauxAssistantMessage("beta done"),
  ]);

  const alphaStarted = await session.request("chat.ask", {
    agent: "alpha",
    interactive: false,
    text: "alpha holds the slot",
  });

  await waitFor(
    () => (h.llm.faux.state.callCount === 1 ? true : undefined),
    "the alpha model request"
  );

  const betaStarted = await session.request("chat.ask", {
    agent: "beta",
    interactive: false,
    text: "beta waits for the slot",
  });

  const blocked = await waitFor(async () => {
    const pressure = await fakePressure(session);

    return pressure?.waiting === 1 ? pressure : undefined;
  }, "beta to wait for the faux slot");

  expect(blocked).toEqual({
    credential: FAKE_CREDENTIAL,
    inUse: 1,
    limit: 1,
    waiting: 1,
  });

  await delay(QUIET_MS);
  expect(h.llm.faux.state.callCount).toBe(1);

  release.resolve(undefined);

  const alphaFinished = await session.waitForEvent(
    "run.finished",
    (payload) => payload.run.runId === alphaStarted.runId
  );

  const betaFinished = await session.waitForEvent(
    "run.finished",
    (payload) => payload.run.runId === betaStarted.runId
  );

  expect(alphaFinished.run).toMatchObject({
    agent: "alpha",
    status: "completed",
  });
  expect(betaFinished.run).toMatchObject({
    agent: "beta",
    status: "completed",
  });
  expect(h.llm.faux.state.callCount).toBe(2);
  expect(Date.parse(betaFinished.run.endedAt ?? "")).toBeGreaterThanOrEqual(
    Date.parse(alphaFinished.run.endedAt ?? "")
  );
  await expect(historyText(session, "beta")).resolves.toContain("beta done");
  await expect(fakePressure(session)).resolves.toEqual({
    credential: FAKE_CREDENTIAL,
    inUse: 0,
    limit: 1,
    waiting: 0,
  });
});

it("keeps a healthy Agent running when another Agent is degraded, and recovers the degraded Agent alone", async () => {
  const h = await start({
    agents: { broken: withBinding, healthy: withBinding },
    prepare: async (homeDir) => {
      const brokenDir = path.join(homeDir, "agents", "broken");

      await mkdir(brokenDir, { recursive: true });
      await writeFile(
        path.join(brokenDir, AGENT_DB_FILE),
        "This file is not a SQLite database.\n".repeat(200)
      );
    },
  });

  const session = await h.connect();
  const status = await session.request("system.status", {});
  const brokenHealth = status.agents.find((agent) => agent.name === "broken");
  const healthyHealth = status.agents.find((agent) => agent.name === "healthy");

  expect(brokenHealth?.state).toBe("degraded");
  expect(brokenHealth?.lastError).toEqual(expect.any(String));
  expect(brokenHealth?.frontends).toEqual([]);
  expect(healthyHealth?.state).toBe("running");
  expect(healthyHealth?.lastError).toBeNull();
  expect(healthyHealth?.frontends).toContainEqual({
    id: BINDING,
    state: "ready",
    type: "fake",
  });

  // The degraded Agent refuses work over JSON-RPC, the CLI, and its Frontend.
  await expect(
    session.request("chat.ask", {
      agent: "broken",
      interactive: false,
      text: "Are you there?",
    })
  ).rejects.toMatchObject({ code: RpcErrorCode.AgentUnavailable });

  const brokenAsk = await h.cli(["ask", "--agent", "broken", "Are you there?"]);

  expect(brokenAsk.code).not.toBe(0);
  await expect(
    h.frontend.send("broken", BINDING, "chat-1", "Are you there?")
  ).rejects.toThrow();

  // The healthy Agent answers over the CLI and its Frontend at the same time.
  h.llm.faux.setResponses(echoes(2));

  const healthyAsk = await h.cli([
    "ask",
    "--agent",
    "healthy",
    "healthy-cli-prompt",
  ]);

  expect(healthyAsk.code).toBe(0);
  expect(healthyAsk.stdout).toMatch(/echo: .*healthy-cli-prompt/u);

  await h.frontend.send(
    "healthy",
    BINDING,
    "chat-1",
    "healthy-frontend-prompt"
  );
  const healthyBinding = h.frontend.binding("healthy", BINDING);

  const reply = await waitFor(
    () =>
      healthyBinding.deliveries.find((delivery) => delivery.kind === "message"),
    "the healthy reply delivery"
  );

  expect(reply.kind === "message" ? reply.text : "").toContain(
    "healthy-frontend-prompt"
  );

  // The Supervisor retries the degraded Agent, and it stays degraded while its storage is broken.
  const retried = await session.waitForEvent(
    "agent.status",
    (payload) => payload.agent === "broken" && payload.state === "starting"
  );

  expect(retried.agent).toBe("broken");
  await waitFor(async () => {
    const health = await session.request("agents.get", { agent: "broken" });

    return health.state === "degraded" && health.restartBackoffMs !== null
      ? true
      : undefined;
  }, "the broken Agent to be degraded with a pending retry");
  expect(
    session.events.some(
      (event) =>
        event.name === "agent.status" &&
        event.payload.agent === "healthy" &&
        event.payload.state !== "running"
    )
  ).toBe(false);

  // After the storage is repaired, only the degraded Agent restarts.
  const brokenDir = h.agentDir("broken");

  await Promise.all(
    ["", "-wal", "-shm"].map(async (suffix) => {
      await rm(path.join(brokenDir, `${AGENT_DB_FILE}${suffix}`), {
        force: true,
      });
    })
  );

  const started = await session.request("agents.start", { agent: "broken" });

  expect(started.state).toBe("running");
  await expect(isFile(path.join(brokenDir, HARNESS_FILE))).resolves.toBe(true);

  const recovered = await session.request("system.status", {});

  expect(recovered.agents.map((agent) => [agent.name, agent.state])).toEqual([
    ["broken", "running"],
    ["healthy", "running"],
  ]);
  expect(
    recovered.agents.find((agent) => agent.name === "broken")?.lastError
  ).toBeNull();

  h.llm.faux.setResponses(echoes(1));
  const brokenRun = await ask(session, "broken", "broken-after-repair");

  expect(brokenRun.status).toBe("completed");
  await expect(historyText(session, "broken")).resolves.toMatch(
    /echo: .*broken-after-repair/u
  );
  await expect(historyText(session, "healthy")).resolves.toMatch(
    /echo: .*healthy-cli-prompt/u
  );
});
