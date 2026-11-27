import { createRequire } from "node:module";
import path from "node:path";

import { defaultClientConditions } from "vite";
import { defineProject } from "vitest/config";

const SOURCE_CONDITION = "@wheatley/source";

// The mock daemon runs inside DOM tests too. The client conditions would resolve `ws` to its browser stub.
const NODE_WS = path.join(
  path.dirname(createRequire(import.meta.url).resolve("ws/package.json")),
  "wrapper.mjs"
);

export default defineProject({
  // Tests in the `happy-dom` environment resolve imports with the client conditions.
  resolve: {
    alias: { ws: NODE_WS },
    conditions: [SOURCE_CONDITION, ...defaultClientConditions],
  },
  ssr: { resolve: { conditions: [SOURCE_CONDITION] } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "mock/**/*.test.ts"],
    name: "dashboard",
  },
});
