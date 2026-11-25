// A Plugin whose setup fails, as a Plugin with a missing credential does.
import { definePlugin } from "@wheatley/sdk";

export default definePlugin({
  apiVersion: 1,
  name: "broken",
  setup: () => {
    throw new Error("missing token");
  },
  version: "1.0.0",
});
