import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const ioModule = fileURLToPath(new URL("io.ts", import.meta.url));

it("reports isTTY as false, not undefined, when standard input is a pipe", () => {
  const script = `
    const { processIo } = await import(${JSON.stringify(ioModule)});
    process.stdout.write(JSON.stringify({ isTTY: processIo().isTTY }));
    process.exit(0);
  `;

  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
  );

  expect(JSON.parse(child.stdout)).toStrictEqual({ isTTY: false });
});
