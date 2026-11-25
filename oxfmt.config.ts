import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  // release-please writes CHANGELOG.md on each release.
  ignorePatterns: [...(ultracite.ignorePatterns ?? []), "CHANGELOG.md"],
});
