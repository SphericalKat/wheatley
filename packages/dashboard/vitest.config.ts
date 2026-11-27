import { defaultClientConditions } from "vite";
import { defineProject } from "vitest/config";

const SOURCE_CONDITION = "@wheatley/source";

export default defineProject({
  // Tests in the `happy-dom` environment resolve imports with the client conditions.
  resolve: { conditions: [SOURCE_CONDITION, ...defaultClientConditions] },
  ssr: { resolve: { conditions: [SOURCE_CONDITION] } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "mock/**/*.test.ts"],
    name: "dashboard",
  },
});
