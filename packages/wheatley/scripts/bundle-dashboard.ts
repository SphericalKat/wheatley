// Copies the dashboard build output into `dist/dashboard/`. The Docker image build runs it, and npm packaging must run
// it before `npm pack`.
import path from "node:path";

import {
  bundleDashboardAssets,
  DASHBOARD_BUILD_DIR,
} from "../src/ops/dashboard-assets.ts";

const packageRoot = path.resolve(import.meta.dirname, "..");
const target = path.join(packageRoot, "dist", "dashboard");

const files = await bundleDashboardAssets(
  path.resolve(packageRoot, DASHBOARD_BUILD_DIR),
  target
);

process.stdout.write(`Bundled ${files} dashboard files into ${target}\n`);
