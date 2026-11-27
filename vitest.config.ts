import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/*/vitest.config.ts",
      "packages/plugins/*/vitest.config.ts",
      "packages/wheatley/vitest.e2e.config.ts",
    ],
  },
});
