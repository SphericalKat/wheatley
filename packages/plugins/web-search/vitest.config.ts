import { defineProject } from "vitest/config";

export default defineProject({
  ssr: { resolve: { conditions: ["@wheatley/source"] } },
  test: { include: ["src/**/*.test.ts"], name: "plugin-web-search" },
});
