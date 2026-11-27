import { readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { FauxResponseFactory } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AGENT_DB_FILE, CLI_CHAT, HARNESS_FILE } from "./agent/agent.js";
import { Deployment } from "./deployment.js";
import type { DeploymentOptions } from "./deployment.js";
import { createDeploymentRpc } from "./rpc/deployment-handlers.js";
import type { SetTimer } from "./supervisor.js";
import {
  builtinCatalog,
  createFakeLlm,
  FAKE_PROVIDER,
  temporaryDir,
} from "./test-support.js";
import type { FakeLlm } from "./test-support.js";

let home: Awaited<ReturnType<typeof temporaryDir>>;
let llm: FakeLlm;
let deployment: Deployment | undefined;

const configYaml = (agents: readonly string[], maxConcurrent: number): string =>
  [
    "version: 1",
    "providers:",
    `  ${FAKE_PROVIDER}:`,
    `    maxConcurrent: ${maxConcurrent}`,
    "agents:",
    ...agents.flatMap((agent) => [
      `  ${agent}:`,
      "    model:",
      `      provider: ${FAKE_PROVIDER}`,
      `      id: ${llm.modelId}`,
    ]),
    "",
  ].join("\n");

const openDeployment = async (
  overrides: Partial<DeploymentOptions> = {}
): Promise<Deployment> => {
  deployment = await Deployment.open({
    env: {},
    extensions: builtinCatalog(),
    homeDir: home.dir,
    models: async () => {
      await Promise.resolve();

      return llm.models;
    },
    version: "test",
    ...overrides,
  });

  return deployment;
};

/** A fake model response that holds its model slot until the test releases it. */
const heldResponse = (text: string) => {
  const release = Promise.withResolvers<undefined>();
  const started = Promise.withResolvers<undefined>();

  const respond: FauxResponseFactory = async () => {
    started.resolve(undefined);
    await release.promise;

    return fauxAssistantMessage(text);
  };

  return {
    release: () => {
      release.resolve(undefined);
    },
    respond,
    started: started.promise,
  };
};

beforeEach(async () => {
  home = await temporaryDir();
  llm = createFakeLlm();
});

afterEach(async () => {
  await deployment?.close();
  deployment = undefined;
  await home.remove();
});

describe("Deployment", () => {
  it("runs two isolated Agents with separate harness.sqlite and agent.sqlite files", async () => {
    await writeFile(
      path.join(home.dir, "config.yaml"),
      configYaml(["alpha", "beta"], 4)
    );
    const opened = await openDeployment();

    llm.faux.setResponses([
      fauxAssistantMessage("from alpha"),
      fauxAssistantMessage("from beta"),
    ]);

    await opened
      .agent("alpha")
      .send(CLI_CHAT, { interactive: true, text: "hello alpha" });
    await vi.waitFor(() => {
      expect(opened.health("alpha").activeRuns).toBe(0);
    });
    await opened
      .agent("beta")
      .send(CLI_CHAT, { interactive: true, text: "hello beta" });
    await vi.waitFor(() => {
      expect(opened.health("beta").activeRuns).toBe(0);
    });

    const alpha = await opened.agent("alpha").history(CLI_CHAT, undefined, 10);
    const beta = await opened.agent("beta").history(CLI_CHAT, undefined, 10);

    expect(alpha.messages.map((message) => message.text)).toStrictEqual([
      "hello alpha",
      "from alpha",
    ]);
    expect(beta.messages.map((message) => message.text)).toStrictEqual([
      "hello beta",
      "from beta",
    ]);

    for (const agent of ["alpha", "beta"]) {
      for (const file of [HARNESS_FILE, AGENT_DB_FILE]) {
        // oxlint-disable-next-line no-await-in-loop -- Each file is checked on its own.
        await expect(
          stat(path.join(home.dir, "agents", agent, file))
        ).resolves.toMatchObject({});
      }
    }

    expect(
      opened.status().agents.map(({ name, state }) => [name, state])
    ).toStrictEqual([
      ["alpha", "running"],
      ["beta", "running"],
    ]);
  });

  it("lists models with models.list, with the current model of a running Agent", async () => {
    await writeFile(
      path.join(home.dir, "config.yaml"),
      configYaml(["alpha"], 4)
    );
    const opened = await openDeployment();
    const rpc = createDeploymentRpc(opened);
    const list = rpc["models.list"];
    const ctx = { connectionId: "c1", signal: new AbortController().signal };

    const models = [
      {
        id: llm.modelId,
        name: llm.faux.getModel().name,
        provider: FAKE_PROVIDER,
      },
    ];

    await expect(list?.({}, ctx)).resolves.toStrictEqual({ models });
    await expect(list?.({ agent: "alpha" }, ctx)).resolves.toStrictEqual({
      current: { id: llm.modelId, provider: FAKE_PROVIDER },
      models,
    });
    await expect(list?.({ agent: "missing" }, ctx)).rejects.toMatchObject({
      code: "agent_not_found",
    });

    await opened.stopAgent("alpha");

    await expect(list?.({ agent: "alpha" }, ctx)).resolves.toStrictEqual({
      models,
    });
  });

  it("holds model requests of every Agent to the provider's maxConcurrent", async () => {
    await writeFile(
      path.join(home.dir, "config.yaml"),
      configYaml(["alpha", "beta"], 1)
    );
    const opened = await openDeployment();
    const first = heldResponse("first");
    const second = heldResponse("second");

    llm.faux.setResponses([first.respond, second.respond]);

    await opened
      .agent("alpha")
      .send(CLI_CHAT, { interactive: true, text: "one" });
    await first.started;
    await opened
      .agent("beta")
      .send(CLI_CHAT, { interactive: true, text: "two" });

    await vi.waitFor(() => {
      expect(opened.gate.pressure()).toStrictEqual([
        { credential: FAKE_PROVIDER, inUse: 1, limit: 1, waiting: 1 },
      ]);
    });
    expect(llm.faux.state.callCount).toBe(1);

    first.release();
    await second.started;

    expect(opened.gate.pressure()).toStrictEqual([
      { credential: FAKE_PROVIDER, inUse: 1, limit: 1, waiting: 0 },
    ]);
    second.release();

    await vi.waitFor(() => {
      expect(
        opened.status().agents.map((agent) => agent.activeRuns)
      ).toStrictEqual([0, 0]);
    });
    expect(opened.gate.pressure()).toStrictEqual([
      { credential: FAKE_PROVIDER, inUse: 0, limit: 1, waiting: 0 },
    ]);
  });

  it("keeps other Agents running while one Agent is degraded, and retries the degraded Agent", async () => {
    await writeFile(
      path.join(home.dir, "config.yaml"),
      configYaml(["alpha", "broken"], 4)
    );
    const timers: (() => void)[] = [];

    const setTimer: SetTimer = (fire) => {
      timers.push(fire);

      return () => {};
    };

    const opened = await Deployment.create({
      env: {},
      extensions: builtinCatalog(),
      homeDir: home.dir,
      models: async () => {
        await Promise.resolve();

        return llm.models;
      },
      setTimer,
      version: "test",
    });

    deployment = opened;
    // A file where the Agent folder belongs makes the Agent fail to open.
    await writeFile(opened.agentDir("broken"), "not a folder");
    await opened.start();

    expect(opened.health("alpha").state).toBe("running");
    expect(opened.health("broken")).toMatchObject({ state: "degraded" });
    expect(opened.health("broken").lastError).not.toBeNull();
    expect(opened.health("broken").restartBackoffMs).toBeGreaterThan(0);

    llm.faux.setResponses([fauxAssistantMessage("still here")]);
    await opened
      .agent("alpha")
      .send(CLI_CHAT, { interactive: true, text: "are you there?" });
    await vi.waitFor(async () => {
      const history = await opened
        .agent("alpha")
        .history(CLI_CHAT, undefined, 10);

      expect(history.messages.at(-1)?.text).toBe("still here");
    });

    await rm(opened.agentDir("broken"));
    timers.shift()?.();

    await vi.waitFor(() => {
      expect(opened.health("broken").state).toBe("running");
    });
  });
  it("fails waitForAgent with agent_unavailable if the Agent is still starting when the wait limit ends", async () => {
    await writeFile(
      path.join(home.dir, "config.yaml"),
      configYaml(["alpha"], 4)
    );
    const timers: (() => void)[] = [];
    let modelsReady: Promise<unknown> = Promise.resolve();

    const setTimer: SetTimer = (fire) => {
      timers.push(fire);

      return () => {};
    };

    const opened = await openDeployment({
      models: async () => {
        await modelsReady;

        return llm.models;
      },
      setTimer,
    });

    const hold = Promise.withResolvers<undefined>();

    modelsReady = hold.promise;

    const restarted = opened.restartAgent("alpha");

    await vi.waitFor(() => {
      expect(opened.health("alpha").state).toBe("starting");
    });

    const armed = timers.length;
    const waited = opened.waitForAgent("alpha");

    await vi.waitFor(() => {
      expect(timers).toHaveLength(armed + 1);
    });
    timers.at(-1)?.();

    await expect(waited).rejects.toMatchObject({ code: "agent_unavailable" });

    hold.resolve(undefined);
    await expect(restarted).resolves.toBe("running");
  });

  it("renames and deletes Agents with their folders and checks expectedRevision first", async () => {
    await writeFile(
      path.join(home.dir, "config.yaml"),
      configYaml(["alpha", "beta"], 4)
    );
    const opened = await openDeployment();
    const start = await opened.getConfig();

    await expect(
      opened.renameAgent("alpha", "gamma", "stale")
    ).rejects.toMatchObject({ code: "revision_conflict" });
    expect(opened.health("alpha").state).toBe("running");

    const renamed = await opened.renameAgent("alpha", "gamma", start.revision);

    expect(opened.agentNames).toStrictEqual(["beta", "gamma"]);
    expect(opened.health("gamma").state).toBe("running");
    await expect(
      stat(path.join(opened.agentDir("gamma"), HARNESS_FILE))
    ).resolves.toMatchObject({});
    await expect(stat(opened.agentDir("alpha"))).rejects.toThrow();

    await opened.deleteAgent({
      agent: "beta",
      data: "archive",
      expectedRevision: renamed.revision,
    });

    expect(opened.agentNames).toStrictEqual(["gamma"]);
    await expect(stat(opened.agentDir("beta"))).rejects.toThrow();
    await expect(readdir(path.join(home.dir, "archive"))).resolves.toHaveLength(
      1
    );
  });

  it("reports pending restarts after a config change and restarts the affected Agents on request", async () => {
    await writeFile(
      path.join(home.dir, "config.yaml"),
      configYaml(["alpha", "beta"], 4)
    );
    const opened = await openDeployment();
    const before = await opened.getConfig();

    const changed = before.raw.replace(
      "  beta:\n",
      "  beta:\n    instructions: Be brief\n"
    );

    const saved = await opened.saveConfig(
      { raw: changed },
      before.revision,
      "none"
    );

    expect(saved.pendingRestart).toStrictEqual([
      { agent: "beta", kind: "agent" },
    ]);
    expect(opened.health("beta").pendingRestart).toBe(true);
    expect(opened.health("alpha").pendingRestart).toBe(false);

    const again = await opened.getConfig();

    const restarted = await opened.saveConfig(
      { raw: again.raw },
      again.revision,
      "affected"
    );

    expect(restarted.pendingRestart).toStrictEqual([]);
    expect(opened.health("beta")).toMatchObject({
      pendingRestart: false,
      state: "running",
    });
  });
});
