import { describe, expect, it } from "vitest";

import { processRunner } from "./command-runner.js";

describe("processRunner", () => {
  it("collects output and the exit code of a failed command", async () => {
    const result = await processRunner.run(process.execPath, [
      "-e",
      "process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 3",
    ]);

    expect(result).toStrictEqual({ exitCode: 3, stderr: "err", stdout: "out" });
  });

  it("rejects if the command does not exist", async () => {
    await expect(
      processRunner.run("wheatley-command-that-does-not-exist", [])
    ).rejects.toThrow("ENOENT");
  });
});
