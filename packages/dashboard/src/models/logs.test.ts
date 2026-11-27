import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { startHarness } from "../../mock/harness.js";
import type { Harness } from "../../mock/harness.js";
import { holdClient } from "./hold-client.js";
import { createLogTail } from "./logs.js";

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness();
});

afterEach(async () => {
  await harness.close();
});

test("keeps a log record that arrives while the tail loads", async () => {
  const held = holdClient(await harness.connect(), ["logs.tail"]);
  const logs = createLogTail(held.client);

  const record = {
    level: "info",
    message: "arrived during the load",
    module: "test",
    seq: 1_000_000,
    at: new Date().toISOString(),
  } as const;

  held.emit("log.record", { record });
  held.release();

  await vi.waitFor(() => {
    expect(logs.state.get().loading).toBe(false);
  });

  expect(logs.state.get().records.map((entry) => entry.seq)).toContain(
    record.seq
  );
});
