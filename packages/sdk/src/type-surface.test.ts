import { execFileSync } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

const tscPath = path.join(
  require.resolve("typescript/package.json"),
  "..",
  "bin",
  "tsc"
);

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const TSC_TIMEOUT_MS = 60_000;

/** Runs the TypeScript compiler and returns its output. Throws with the output if it reports errors. */
const tsc = (args: readonly string[]): string =>
  execFileSync(process.execPath, [tscPath, ...args], {
    encoding: "utf-8",
    timeout: TSC_TIMEOUT_MS,
  });

let workDir = "";

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "wheatley-sdk-surface-"));
  const installDir = path.join(workDir, "node_modules", "@wheatley-ai", "sdk");

  tsc([
    "-p",
    path.join(packageDir, "tsconfig.build.json"),
    "--emitDeclarationOnly",
    "--declarationMap",
    "false",
    "--outDir",
    path.join(installDir, "dist"),
  ]);
  await cp(
    path.join(packageDir, "package.json"),
    path.join(installDir, "package.json")
  );
}, TSC_TIMEOUT_MS);

afterAll(async () => {
  await rm(workDir, { force: true, recursive: true });
});

describe("@wheatley-ai/sdk public type surface", () => {
  it(
    "type-checks a consumer with no pi-durable, Node.js types, or other packages installed",
    async () => {
      await writeFile(
        path.join(workDir, "consumer.ts"),
        [
          'import type * as sdk from "@wheatley-ai/sdk";',
          'import { API_VERSION, chunkMarkdown, definePlugin } from "@wheatley-ai/sdk";',
          "export const plugin: sdk.Plugin = definePlugin({",
          '  apiVersion: API_VERSION, name: "probe", version: "1.0.0", setup: () => ({}),',
          "});",
          'export const chunks: string[] = chunkMarkdown("text", 64);',
          "",
        ].join("\n")
      );
      await writeFile(
        path.join(workDir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            lib: ["ES2024", "DOM"],
            module: "NodeNext",
            moduleResolution: "NodeNext",
            noEmit: true,
            skipLibCheck: false,
            strict: true,
            types: [],
          },
          files: ["consumer.ts"],
        })
      );

      expect(tsc(["-p", path.join(workDir, "tsconfig.json")])).toBe("");
    },
    TSC_TIMEOUT_MS
  );
});
