import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  // release-please writes CHANGELOG.md on each release; oxfmt corrupts Starlight MDX <Steps> and ::: directives.
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    "CHANGELOG.md",
    "packages/docs/src/content/docs/**/*.mdx",
  ],
});
