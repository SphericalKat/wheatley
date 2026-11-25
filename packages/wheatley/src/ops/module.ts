import type { DatabaseSync } from "node:sqlite";

import type { DeploymentModule, RpcHandlerMap } from "../contracts/module.js";
import type { Migration, MigrationNamespace } from "../db/migrations.js";
import { listBackups } from "./backup.js";
import type { BackupInfo } from "./backup.js";
import { dashboardAssetsDir } from "./dashboard-assets.js";
import { migrateAgentDatabase } from "./migrate.js";
import type { AgentMigrationReport } from "./migrate.js";
import { agentDirFor } from "./paths.js";

/** The ops API that the Deployment and the Supervisor use. */
export interface OpsApi {
  /**
   * Backs up the Agent's `agent.sqlite` with `VACUUM INTO` if a migration is pending, keeps the 5 newest backups, and
   * applies the migrations of every module.
   *
   * Ordering: the Agent calls it after it opens `agent.sqlite` and before it creates any module.
   *
   * Errors: it never rejects for a migration or backup failure. On `outcome: "degraded"`, the Supervisor must set the
   * Agent to `degraded` with `error` as `lastError`, emit `agent.status`, and must not create the Agent's modules. It
   * logs the failure through the Deployment logger. It throws only for an invalid Agent name.
   */
  readonly migrateAgent: (
    agent: string,
    db: DatabaseSync,
    namespaces: readonly MigrationNamespace[]
  ) => Promise<AgentMigrationReport>;
  /** Lists the backups of one Agent, newest first. Errors: throws for an invalid Agent name. */
  readonly listBackups: (agent: string) => Promise<BackupInfo[]>;
  /** The folder of the bundled dashboard assets that the Control Server serves on `/`. */
  readonly dashboardAssetsDir: string;
}

/** The ops module takes no dependencies beyond the Deployment context. */
export type OpsDeps = Readonly<Record<string, never>>;

/** The ops module owns no `agent.sqlite` tables. */
export const opsMigrations: readonly Migration[] = [];

/** The ops module serves no JSON-RPC methods: `service`, `update`, and `restore` are offline CLI commands. */
export const opsRpcHandlers: RpcHandlerMap = {};

/** The Deployment-scoped ops module: pre-migration backups and per-Agent degraded reports. */
export const opsModule: DeploymentModule<OpsDeps, OpsApi> = {
  create: (ctx) => {
    const migrateAgent: OpsApi["migrateAgent"] = async (
      agent,
      db,
      namespaces
    ) => {
      const report = await migrateAgentDatabase(db, {
        agent,
        agentDir: agentDirFor(ctx.homeDir, agent),
        clock: ctx.clock,
        namespaces,
      });

      if (report.outcome === "degraded") {
        ctx.log.error("Agent migration failed", {
          agent,
          backup: report.backup?.file ?? null,
          code: report.code,
          error: report.error,
        });
      } else if (report.applied.length > 0) {
        ctx.log.info("Agent migrations applied", {
          agent,
          applied: report.applied.length,
          backup: report.backup?.file ?? null,
        });
      }

      return report;
    };

    return {
      api: {
        dashboardAssetsDir: dashboardAssetsDir(),
        listBackups: async (agent) =>
          await listBackups(agentDirFor(ctx.homeDir, agent)),
        migrateAgent,
      },
      rpc: opsRpcHandlers,
    };
  },
  name: "ops",
  scope: "deployment",
};
