import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InMemoryMaintenanceRunner } from "../contracts/maintenance-runner.fake.js";
import type { MaintenanceRunResult } from "../contracts/maintenance-runner.js";
import { CONSOLIDATION_JOB } from "./module.js";
import { createMemoryFixture, rpcContext } from "./test-harness.js";
import type { MemoryFixture } from "./test-harness.js";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** A maintenance runner whose Runs end only when the test calls `finish`. */
interface ControlledRunner {
  readonly runner: InMemoryMaintenanceRunner;
  /** Ends the oldest Run that has not ended yet. */
  readonly finish: (result: MaintenanceRunResult) => void;
}

const createControlledRunner = (): ControlledRunner => {
  const pending: PromiseWithResolvers<MaintenanceRunResult>[] = [];

  const runner = new InMemoryMaintenanceRunner(async () => {
    const run = Promise.withResolvers<MaintenanceRunResult>();

    pending.push(run);

    return await run.promise;
  });

  const finish = (result: MaintenanceRunResult): void => {
    pending.shift()?.resolve(result);
  };

  return { finish, runner };
};

let fixture: MemoryFixture;

beforeEach(async () => {
  vi.useFakeTimers({
    now: new Date("2026-11-26T02:58:00.000Z"),
    toFake: ["Date", "setTimeout", "clearTimeout"],
  });
  fixture = await createMemoryFixture();
});

afterEach(async () => {
  await fixture.dispose();
  vi.useRealTimers();
});

describe("on-demand consolidation", () => {
  it("starts a maintenance Run with the file inventory and model, and logs its result", async () => {
    const runner = new InMemoryMaintenanceRunner(() => ({
      status: "completed",
      text: "  Merged two facts.  ",
    }));

    const memory = await fixture.create({
      config: {
        consolidation: {
          enabled: false,
          model: "faux/small-1",
        },
      },
      maintenance: runner,
    });

    await memory.api.store.write("travel", "Window seats.", "replace");

    const { runId } = (await memory.rpc["memory.consolidate"]?.(
      { agent: "home" },
      rpcContext
    )) ?? { runId: "" };

    expect(runner.requests).toMatchObject([
      {
        job: CONSOLIDATION_JOB,
        model: "faux/small-1",
      },
    ]);
    expect(runner.requests[0]?.prompt).toContain("travel.md: 13 characters");

    await vi.waitFor(() => {
      expect(memory.api.consolidation.log(10)).toMatchObject([
        {
          runId,
          status: "completed",
          summary: "Merged two facts.",
        },
      ]);
    });
    expect(memory.api.consolidation.log(1)[0]?.endedAt).not.toBeNull();
    await expect(
      memory.rpc["memory.consolidationLog"]?.({ agent: "home" }, rpcContext)
    ).resolves.toMatchObject({
      entries: [{ runId, status: "completed" }],
    });
  });

  it("rejects a second consolidation while one runs", async () => {
    const { finish, runner } = createControlledRunner();

    const memory = await fixture.create({
      config: { consolidation: { enabled: false } },
      maintenance: runner,
    });

    await memory.api.consolidation.run();

    await expect(memory.api.consolidation.run()).rejects.toMatchObject({
      code: "conflict",
    });

    finish({ status: "completed", text: "" });

    await vi.waitFor(() => {
      expect(memory.api.consolidation.log(1)).toMatchObject([
        { status: "completed" },
      ]);
    });
    await expect(memory.api.consolidation.run()).resolves.toMatchObject({
      runId: "maintenance-run-2",
    });
  });

  it("logs a failed or stopped Run as failed with its error", async () => {
    const { finish, runner } = createControlledRunner();

    const memory = await fixture.create({
      config: { consolidation: { enabled: false } },
      maintenance: runner,
    });

    await memory.api.consolidation.run();
    finish({ error: "model unavailable", status: "failed", text: "" });
    await vi.waitFor(() => {
      expect(memory.api.consolidation.log(1)).toMatchObject([
        { error: "model unavailable", status: "failed" },
      ]);
    });

    await memory.api.consolidation.run();
    finish({ status: "stopped", text: "" });
    await vi.waitFor(() => {
      expect(memory.api.consolidation.log(1)).toMatchObject([
        { error: "The consolidation Run was stopped.", status: "failed" },
      ]);
    });
  });

  it("resumes a Run that was still running when the Agent stopped", async () => {
    const { finish, runner } = createControlledRunner();

    const first = await fixture.create({
      config: { consolidation: { enabled: false } },
      maintenance: runner,
    });

    await first.api.consolidation.run();
    await first.stop?.();

    const second = await fixture.create({
      config: { consolidation: { enabled: false } },
      maintenance: runner,
    });

    await second.start?.();

    await expect(second.api.consolidation.run()).rejects.toMatchObject({
      code: "conflict",
    });

    finish({ status: "completed", text: "Done." });

    await vi.waitFor(() => {
      expect(second.api.consolidation.log(10)).toMatchObject([
        { status: "completed", summary: "Done." },
      ]);
    });
  });
});

describe("scheduled consolidation", () => {
  it("runs by default every day at 03:00 in the configured timezone", async () => {
    const runner = new InMemoryMaintenanceRunner();

    const memory = await fixture.create({
      config: { consolidation: { timezone: "UTC" } },
      maintenance: runner,
    });

    await memory.start?.();
    await vi.advanceTimersByTimeAsync(MINUTE_MS);

    expect(runner.requests).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    await vi.waitFor(() => {
      expect(runner.requests).toMatchObject([{ job: CONSOLIDATION_JOB }]);
    });

    await vi.advanceTimersByTimeAsync(DAY_MS);
    await vi.waitFor(() => {
      expect(runner.requests).toHaveLength(2);
    });
  });

  it("follows a custom schedule and stops with the module", async () => {
    const runner = new InMemoryMaintenanceRunner();

    const memory = await fixture.create({
      config: { consolidation: { schedule: "*/10 * * * *", timezone: "UTC" } },
      maintenance: runner,
    });

    await memory.start?.();
    await vi.advanceTimersByTimeAsync(2 * MINUTE_MS);
    await vi.waitFor(() => {
      expect(runner.requests).toHaveLength(1);
    });

    await memory.stop?.();
    await vi.advanceTimersByTimeAsync(DAY_MS);

    expect(runner.requests).toHaveLength(1);
  });

  it("does not schedule when consolidation is disabled", async () => {
    const runner = new InMemoryMaintenanceRunner();

    const memory = await fixture.create({
      config: { consolidation: { enabled: false } },
      maintenance: runner,
    });

    await memory.start?.();
    await vi.advanceTimersByTimeAsync(2 * DAY_MS);

    expect(runner.requests).toHaveLength(0);
  });

  it("catches up once on start if the schedule passed a slot while the Agent was stopped", async () => {
    const runner = new InMemoryMaintenanceRunner();
    const config = { consolidation: { timezone: "UTC" } };
    const first = await fixture.create({ config, maintenance: runner });

    await first.api.consolidation.run();
    await vi.waitFor(() => {
      expect(first.api.consolidation.log(1)).toMatchObject([
        { status: "completed" },
      ]);
    });
    await first.stop?.();

    vi.setSystemTime(new Date("2026-11-27T12:00:00.000Z"));

    const second = await fixture.create({ config, maintenance: runner });

    await second.start?.();
    await vi.waitFor(() => {
      expect(runner.requests).toHaveLength(2);
    });
  });

  it("ignores an invalid schedule when consolidation is disabled", async () => {
    const runner = new InMemoryMaintenanceRunner();

    const memory = await fixture.create({
      config: {
        consolidation: {
          enabled: false,
          schedule: "not a cron",
          timezone: "Nowhere/Invalid",
        },
      },
      maintenance: runner,
    });

    await memory.start?.();

    await expect(memory.api.consolidation.run()).resolves.toMatchObject({
      runId: "maintenance-run-1",
    });
  });

  it("rejects an invalid schedule when the module is created", async () => {
    await expect(
      fixture.create({ config: { consolidation: { schedule: "not a cron" } } })
    ).rejects.toThrow(/Invalid memory\.consolidation schedule/u);
  });
});
