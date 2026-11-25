import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import {
  defaultClientConditions,
  defaultServerConditions,
  defineConfig,
} from "vite";

import { mockServerPlugin } from "./mock/vite-plugin.js";

/** Resolves workspace packages from their TypeScript source, as the typecheck and tests do. */
const SOURCE_CONDITION = "@wheatley/source";

export default defineConfig({
  build: { emptyOutDir: true, outDir: "dist" },
  plugins: [react(), tailwindcss(), mockServerPlugin()],
  resolve: { conditions: [SOURCE_CONDITION, ...defaultClientConditions] },
  ssr: {
    resolve: { conditions: [SOURCE_CONDITION, ...defaultServerConditions] },
  },
});
