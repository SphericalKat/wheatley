import { describe, expect, it } from "vitest";

import { RESTART_BACKOFF_INITIAL_MS, Supervisor } from "./supervisor.js";
import type { AgentControls, SetTimer, SupervisedAgent } from "./supervisor.js";
import { EventRecorder, silentLogger } from "./test-support.js";

interface FakeAgent extends SupervisedAgent {
  readonly name: string;
  readonly controls: AgentControls;
  closed: boolean;
}

interface Harness {
  readonly supervisor: Supervisor<FakeAgent>;
  readonly events: EventRecorder;
  readonly opened: FakeAgent[];
  readonly delays: number[];
  readonly fireTimer: () => void;
  readonly failing: Set<string>;
}

const harness = (): Harness => {
  const events = new EventRecorder();
  const opened: FakeAgent[] = [];
  const timers: (() => void)[] = [];
  const delays: number[] = [];
  const failing = new Set<string>();
  let now = 0;

  const setTimer: SetTimer = (fire, delayMs) => {
    delays.push(delayMs);
    timers.push(() => {
      now += delayMs;
      fire();
    });

    return () => {
      timers.length = 0;
    };
  };

  const supervisor = new Supervisor<FakeAgent>({
    clock: { now: () => now },
    events,
    log: silentLogger,
    open: async (name, controls) => {
      await Promise.resolve();

      if (failing.has(name)) {
        throw new Error(`${name} cannot open`);
      }

      const agent: FakeAgent = {
        close: async () => {
          await Promise.resolve();
          agent.closed = true;
        },
        closed: false,
        controls,
        name,
      };

      opened.push(agent);

      return agent;
    },
    setTimer,
  });

  return {
    delays,
    events,
    failing,
    fireTimer: () => {
      timers.shift()?.();
    },
    opened,
    supervisor,
  };
};

const settle = async (): Promise<void> => {
  for (let step = 0; step < 10; step += 1) {
    // oxlint-disable-next-line no-await-in-loop -- Each step lets queued lifecycle work run.
    await Promise.resolve();
  }
};

describe("Supervisor", () => {
  it("degrades only the Agent that fails to start and retries it with growing backoff", async () => {
    const { supervisor, failing, delays, fireTimer, events } = harness();

    failing.add("broken");

    await expect(supervisor.start("home")).resolves.toBe("running");
    await expect(supervisor.start("broken")).resolves.toBe("degraded");
    expect(supervisor.get("broken")).toMatchObject({
      lastError: "broken cannot open",
      state: "degraded",
    });
    expect(supervisor.get("home")?.state).toBe("running");

    fireTimer();
    await settle();
    expect(delays).toStrictEqual([
      RESTART_BACKOFF_INITIAL_MS,
      RESTART_BACKOFF_INITIAL_MS * 2,
    ]);

    failing.delete("broken");
    fireTimer();
    await settle();

    expect(supervisor.get("broken")).toMatchObject({
      lastError: null,
      restartBackoffMs: null,
      state: "running",
    });
    expect(
      events
        .of("agent.status")
        .filter(({ agent }) => agent === "broken")
        .map(({ state }) => state)
    ).toStrictEqual([
      "starting",
      "degraded",
      "starting",
      "degraded",
      "starting",
      "running",
    ]);
  });

  it("closes a running Agent that reports a failure and restarts it later", async () => {
    const { supervisor, opened, fireTimer } = harness();

    await supervisor.start("home");
    const [first] = opened;

    first?.controls.onFailed(new Error("storage failed"));
    await settle();

    expect(first?.closed).toBe(true);
    expect(supervisor.get("home")).toMatchObject({
      lastError: "storage failed",
      state: "degraded",
    });

    fireTimer();
    await settle();

    expect(supervisor.get("home")?.state).toBe("running");
    expect(opened).toHaveLength(2);

    first?.controls.onFailed(new Error("a stale failure"));
    await settle();
    expect(supervisor.get("home")?.state).toBe("running");
  });

  it("stops, restarts on request, and forgets Agents", async () => {
    const { supervisor, opened } = harness();

    await supervisor.start("home");
    opened[0]?.controls.onRestartRequested();
    await settle();

    expect(opened.map((agent) => agent.closed)).toStrictEqual([true, false]);
    await expect(supervisor.stop("home")).resolves.toBe("stopped");
    expect(opened[1]?.closed).toBe(true);

    await supervisor.remove("home");
    expect(supervisor.names).toStrictEqual([]);
  });
});
