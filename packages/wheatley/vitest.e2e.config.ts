import { defineProject } from "vitest/config";

/** End-to-end flows start a real daemon per test, so they get longer time limits than unit tests. */
const E2E_TIMEOUT_MS = 60_000;

export default defineProject({
  ssr: { resolve: { conditions: ["@wheatley/source"] } },
  test: {
    hookTimeout: E2E_TIMEOUT_MS,
    include: ["test/e2e/**/*.test.ts"],
    name: "wheatley-e2e",
    testTimeout: E2E_TIMEOUT_MS,
  },
});
