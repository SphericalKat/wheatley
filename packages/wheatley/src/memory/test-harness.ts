import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type {
  EventName,
  EventPayload,
  MemoryConfig,
} from "@wheatley-ai/protocol";
import type { Logger } from "@wheatley-ai/sdk";

import { InMemoryMaintenanceRunner } from "../contracts/maintenance-runner.fake.js";
import type { MaintenanceRunner } from "../contracts/maintenance-runner.js";
import { migrationNamespace, systemClock } from "../contracts/module.js";
import type { ModuleInstance, RpcContext } from "../contracts/module.js";
import { openAgentDatabase } from "../db/database.js";
import { runMigrations } from "../db/migrations.js";
import { memoryModule } from "./module.js";
import type { MemoryApi } from "./module.js";
import { MEMORY_DIR_NAME } from "./names.js";

/** One event that the module emitted. */
export interface EmittedEvent {
  readonly name: EventName;
  readonly payload: EventPayload<EventName>;
}

/** One record that the module logged. */
export interface LogEntry {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
}

/** A test Agent folder and `agent.sqlite` with the Memory migrations applied. */
export interface MemoryFixture {
  readonly agentDir: string;
  readonly memoryDir: string;
  readonly db: DatabaseSync;
  readonly events: EmittedEvent[];
  readonly logs: LogEntry[];
  /** Creates a Memory module instance over this folder and database, as the Agent does at start. */
  readonly create: (options?: {
    readonly config?: MemoryConfig;
    readonly maintenance?: MaintenanceRunner;
  }) => Promise<ModuleInstance<MemoryApi>>;
  /** Stops every created instance, closes the database, and removes the folder. */
  readonly dispose: () => Promise<void>;
}

/** The context of a JSON-RPC request in tests. */
export const rpcContext: RpcContext = {
  connectionId: "test-connection",
  signal: new AbortController().signal,
};

/** Creates a fixture for the Memory module of the Agent `home`. */
export const createMemoryFixture = async (): Promise<MemoryFixture> => {
  const agentDir = await mkdtemp(path.join(tmpdir(), "wheatley-memory-"));
  const db = openAgentDatabase(":memory:");
  const events: EmittedEvent[] = [];
  const logs: LogEntry[] = [];
  const instances: ModuleInstance<MemoryApi>[] = [];

  runMigrations(db, [migrationNamespace(memoryModule)]);

  const log: Logger = {
    debug: (message) => {
      logs.push({ level: "debug", message });
    },
    error: (message) => {
      logs.push({ level: "error", message });
    },
    info: (message) => {
      logs.push({ level: "info", message });
    },
    warn: (message) => {
      logs.push({ level: "warn", message });
    },
  };

  const create: MemoryFixture["create"] = async (options) => {
    const instance = await memoryModule.create(
      {
        agentDir,
        agentName: "home",
        clock: systemClock,
        db,
        events: {
          emit: (name, payload) => {
            events.push({ name, payload });
          },
        },
        log,
      },
      {
        config: options?.config,
        maintenance: options?.maintenance ?? new InMemoryMaintenanceRunner(),
      }
    );

    instances.push(instance);

    return instance;
  };

  const dispose = async (): Promise<void> => {
    await Promise.all(
      instances.map(async (instance) => await instance.stop?.())
    );

    db.close();
    await rm(agentDir, { force: true, recursive: true });
  };

  return {
    agentDir,
    create,
    db,
    dispose,
    logs,
    events,
    memoryDir: path.join(agentDir, MEMORY_DIR_NAME),
  };
};
