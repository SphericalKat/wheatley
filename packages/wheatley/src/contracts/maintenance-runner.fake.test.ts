import { describe, expect, it } from "vitest";

import { InMemoryMaintenanceRunner } from "./maintenance-runner.fake.js";

describe("InMemoryMaintenanceRunner", () => {
  it("resolves wait with the result of the started Run and rejects an unknown Run", async () => {
    const runner = new InMemoryMaintenanceRunner((request) => ({
      status: "completed",
      text: `done: ${request.job}`,
    }));

    const { runId } = await runner.start({
      job: "memory.consolidate",
      model: { id: "small-1", provider: "faux" },
      prompt: "Consolidate Memory",
    });

    await expect(runner.wait(runId)).resolves.toStrictEqual({
      status: "completed",
      text: "done: memory.consolidate",
    });
    await expect(runner.wait("run-404")).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
