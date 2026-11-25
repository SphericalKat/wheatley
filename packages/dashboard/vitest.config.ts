import { defineProject } from "vitest/config";

export default defineProject({
  ssr: { resolve: { conditions: ["@wheatley/source"] } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "mock/**/*.test.ts"],
    name: "dashboard",
  },
});
