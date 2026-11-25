import {
  decodeClientMessage,
  encodeRequest,
  encodeResult,
} from "@wheatley-ai/protocol";
import { describe, expect, it } from "vitest";

import { openAgentDatabase } from "../db/database.js";
import { runMigrations } from "../db/migrations.js";
import { migrationNamespace, systemClock } from "./module.js";
import type { AgentModule, AgentModuleContext } from "./module.js";

interface NotesApi {
  readonly count: () => number;
}

/** A minimal Agent module in the shape that every Wave 1 track exports. */
const notesModule: AgentModule<{ readonly seed: number }, NotesApi> = {
  create: (ctx, deps) => {
    ctx.db.prepare("INSERT INTO notes_items (id) VALUES (?)").run(deps.seed);

    const count = (): number =>
      Number(
        ctx.db.prepare("SELECT count(*) AS total FROM notes_items").get()?.total
      );

    return {
      api: { count },
      rpc: {
        "memory.reindex": async () => {
          await Promise.resolve();

          return { files: count() };
        },
      },
    };
  },
  migrations: [
    {
      name: "create items",
      up: (db) => {
        db.exec("CREATE TABLE notes_items (id INTEGER PRIMARY KEY)");
      },
      version: 1,
    },
  ],
  name: "notes",
  scope: "agent",
};

describe("AgentModule wiring", () => {
  it("runs module migrations, creates the module, and serves a decoded request", async () => {
    const db = openAgentDatabase(":memory:");

    try {
      runMigrations(db, [migrationNamespace(notesModule)]);

      const ctx: AgentModuleContext = {
        agentDir: "/data/agents/home",
        agentName: "home",
        clock: systemClock,
        db,
        events: { emit: () => {} },
        log: {
          debug: () => {},
          error: () => {},
          info: () => {},
          warn: () => {},
        },
      };

      const instance = await notesModule.create(ctx, { seed: 7 });

      const decoded = decodeClientMessage(
        encodeRequest(1, "memory.reindex", { agent: "home" })
      );

      expect(decoded.ok && decoded.request.method).toBe("memory.reindex");

      const result = await instance.rpc["memory.reindex"]?.(
        { agent: "home" },
        { connectionId: "c1", signal: new AbortController().signal }
      );

      expect(result).toStrictEqual({ files: 1 });
      expect(encodeResult(1, "memory.reindex", result ?? { files: 0 })).toBe(
        '{"id":1,"jsonrpc":"2.0","result":{"files":1}}'
      );
      expect(instance.api.count()).toBe(1);
    } finally {
      db.close();
    }
  });
});
