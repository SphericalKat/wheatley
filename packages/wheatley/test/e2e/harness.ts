// The end-to-end harness: a real Wheatley daemon (every v1 module, the real pi-durable Harness, and the real Control
// Server) in a temporary home folder, driven by a scripted fake LLM, JSON-RPC clients over `/ws`, the CLI, and fake
// Frontend transports.
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type {
  AssistantMessage,
  FauxResponseFactory,
} from "@earendil-works/pi-ai";
import type {
  AgentConfig,
  DeploymentConfig,
  EventName,
  EventPayload,
  RpcEvent,
} from "@wheatley-ai/protocol";
import type { Frontend } from "@wheatley-ai/sdk";
import { stringify } from "yaml";

import { DaemonClient } from "../../src/cli/client.js";
import type { CliIo } from "../../src/cli/io.js";
import { runCli } from "../../src/cli/main.js";
import type { CliOverrides } from "../../src/cli/main.js";
import { createFakeLlm, FAKE_PROVIDER } from "../../src/core/test-support.js";
import type { FakeLlm, FakeLlmOptions } from "../../src/core/test-support.js";
import { startWheatley } from "../../src/wiring/daemon.js";
import type { WheatleyDaemon } from "../../src/wiring/daemon.js";
import { createFakeFrontend } from "./fake-frontend.js";
import type { FakeFrontend } from "./fake-frontend.js";

/** The default time limit of every `wait*` helper. */
export const DEFAULT_WAIT_MS = 10_000;

const POLL_MS = 20;

/** The version that the daemon reports in `system.status`. */
export const E2E_VERSION = "0.0.0-e2e";

/** The default Agent of a harness. */
export const DEFAULT_AGENT = "home";

/** The built dashboard of the workspace. The harness serves it if `pnpm build` produced it. */
export const BUILT_DASHBOARD_DIR = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "dashboard",
  "dist"
);

/** One Agent of the harness config: every field is optional, and the model defaults to the fake LLM. */
export type HarnessAgentConfig = Partial<AgentConfig>;

/** Options of `startHarness`. */
export interface HarnessOptions {
  /** The Agents in `config.yaml`. The default is one Agent, `home`, that allows every Tool. */
  readonly agents?: Readonly<Record<string, HarnessAgentConfig>>;
  /** Other top-level `config.yaml` fields, for example `webhooks` or `daemon.allowedOrigins`. */
  readonly config?: Partial<Omit<DeploymentConfig, "agents" | "version">>;
  /** The values of `secrets.yaml`. */
  readonly secrets?: Readonly<Record<string, string>>;
  /**
   * The built-in Frontends. The default is one `FakeFrontend` of type `fake` (see `harness.frontend`). Pass real
   * Frontends with fake platform clients, for example `createTelegramFrontend({ createClient })`, to test an adapter.
   */
  readonly frontends?: readonly Frontend[];
  /** The dashboard folder for `/`. The default is the workspace dashboard build, if it exists. `null` serves none. */
  readonly dashboardDir?: string | null;
  /** Options of the fake LLM, for example a small `contextWindow` to force automatic compaction. */
  readonly llm?: FakeLlmOptions;
  /** Writes files into the home folder before the daemon starts, for example Skills, Plugins, or Agent files. */
  readonly prepare?: (homeDir: string) => Promise<void>;
  /** Extra overrides of `wheatley service`, `update`, and `restore`. */
  readonly ops?: CliOverrides["ops"];
}

/** A JSON-RPC connection over `/ws` that subscribes to every event and records it. */
export interface RpcSession {
  readonly client: DaemonClient;
  readonly request: DaemonClient["request"];
  /** Every event that arrived, in order. */
  readonly events: readonly RpcEvent[];
  /**
   * Resolves with the payload of the first event named `name` that matches `predicate`, including events that arrived
   * before the call. Rejects after `timeoutMs`.
   */
  readonly waitForEvent: <E extends EventName>(
    name: E,
    predicate?: (payload: EventPayload<E>) => boolean,
    timeoutMs?: number
  ) => Promise<EventPayload<E>>;
  readonly close: () => Promise<void>;
}

/** The outcome of one finished CLI command. */
export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** A running CLI command whose standard input the test writes line by line, for example to answer Approvals. */
export interface CliSession {
  /** Sends one line of standard input. */
  readonly write: (line: string) => void;
  /** Closes standard input. */
  readonly end: () => void;
  readonly stdout: () => string;
  readonly stderr: () => string;
  /** Resolves once standard output matches `pattern`. Rejects after `timeoutMs`. */
  readonly waitForOutput: (
    pattern: RegExp,
    timeoutMs?: number
  ) => Promise<void>;
  /** Resolves when the command exits. */
  readonly result: Promise<CliResult>;
}

/** Options of one CLI command. */
export interface CliOptions {
  /** Lines of standard input. Standard input closes after the last line. */
  readonly input?: readonly string[];
  /** True to act like a terminal, so `ask` Runs are interactive. The default is false. */
  readonly isTTY?: boolean;
}

/** A running end-to-end Deployment. Call `cleanup` in `afterEach`. */
export interface Harness {
  /** The temporary Wheatley home folder. */
  readonly homeDir: string;
  /** The scripted LLM. Queue responses with `llm.faux.setResponses` before each Run. */
  readonly llm: FakeLlm;
  /** The default fake Frontend, unless `HarnessOptions.frontends` replaced it. */
  readonly frontend: FakeFrontend;
  /** The running daemon. It changes after `restart`. */
  readonly daemon: () => WheatleyDaemon;
  /** `ws://127.0.0.1:<port>/ws`. */
  readonly wsUrl: () => string;
  /** `http://127.0.0.1:<port>`, which serves the dashboard on `/`. */
  readonly httpUrl: () => string;
  /** `<home>/agents/<name>`. */
  readonly agentDir: (name?: string) => string;
  /** `<home>/agents/<name>/workspace`, the working folder of the Agent's Tools. */
  readonly workspaceDir: (name?: string) => string;
  /** Opens a JSON-RPC session over TCP `/ws`. The harness closes it in `cleanup`. */
  readonly connect: () => Promise<RpcSession>;
  /** Runs one CLI command against this home folder, for example `["ask", "--agent", "home", "Hi"]`. */
  readonly cli: (
    argv: readonly string[],
    options?: CliOptions
  ) => Promise<CliResult>;
  /** Starts one CLI command with interactive standard input. */
  readonly cliSession: (
    argv: readonly string[],
    options?: { readonly isTTY?: boolean }
  ) => CliSession;
  /** Stops the daemon and starts it again on the same home folder, for example to test durable state. */
  readonly restart: () => Promise<void>;
  /** Stops the daemon. `cleanup` also does it. */
  readonly stop: () => Promise<void>;
  /** Stops the daemon, closes every session, and deletes the home folder. */
  readonly cleanup: () => Promise<void>;
}

/** Resolves once `check` returns a value other than `undefined`. Rejects after `timeoutMs`. */
export const waitFor = async <T>(
  check: () => T | undefined | Promise<T | undefined>,
  description: string,
  timeoutMs = DEFAULT_WAIT_MS
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- The condition is polled until it holds.
    const value = await check();

    if (value !== undefined) {
      return value;
    }

    if (Date.now() > deadline) {
      throw new Error(
        `Timed out after ${timeoutMs} ms waiting for ${description}`
      );
    }

    // oxlint-disable-next-line no-await-in-loop -- The condition is polled until it holds.
    await delay(POLL_MS);
  }
};

/** An event with a known name. */
interface EventOf<E extends EventName> {
  readonly name: E;
  readonly payload: EventPayload<E>;
}

const isEventOf = <E extends EventName>(
  event: RpcEvent,
  name: E
): event is RpcEvent & EventOf<E> => event.name === name;

/** Re-exported so flow files script the LLM without another import path. */
export type ScriptedResponse = AssistantMessage | FauxResponseFactory;

const exists = async (target: string): Promise<boolean> => {
  try {
    await stat(target);

    return true;
  } catch {
    return false;
  }
};

/** The workspace dashboard build, or `undefined` if `pnpm build` did not run. */
const builtDashboard = async (): Promise<string | undefined> =>
  (await exists(path.join(BUILT_DASHBOARD_DIR, "index.html")))
    ? BUILT_DASHBOARD_DIR
    : undefined;

/** A pushable queue of standard input lines. */
const lineQueue = (initial: readonly string[], closed: boolean) => {
  const lines = [...initial];
  const state = { ended: closed };
  let wake = Promise.withResolvers<undefined>();

  const iterator: AsyncIterator<string> = {
    next: async () => {
      while (lines.length === 0 && !state.ended) {
        // oxlint-disable-next-line no-await-in-loop -- Standard input waits for the next pushed line.
        await wake.promise;
        wake = Promise.withResolvers<undefined>();
      }

      const line = lines.shift();

      return line === undefined
        ? { done: true, value: undefined }
        : { done: false, value: line };
    },
  };

  return {
    end: () => {
      state.ended = true;
      wake.resolve(undefined);
    },
    iterator,
    push: (line: string) => {
      lines.push(line);
      wake.resolve(undefined);
    },
  };
};

const fullAgentConfig = (
  llm: FakeLlm,
  config: HarnessAgentConfig
): AgentConfig => ({
  permissionPolicy: [{ action: "allow", tool: "*" }],
  ...config,
  model: config.model ?? `${FAKE_PROVIDER}/${llm.modelId}`,
});

/** The standard streams of one CLI command. */
const ioFor = (
  input: ReturnType<typeof lineQueue>,
  isTTY: boolean,
  out: string[],
  err: string[]
): CliIo => ({
  env: {},
  isTTY,
  lines: input.iterator,
  shutdown: new AbortController().signal,
  stderr: (text) => {
    err.push(text);
  },
  stdout: (text) => {
    out.push(text);
  },
});

/**
 * Starts a Deployment in a new temporary home folder and waits until every Agent left `starting`.
 *
 * Example:
 * ```ts
 * const harness = await startHarness();
 * harness.llm.faux.setResponses([fauxAssistantMessage("Hello")]);
 * const result = await harness.cli(["ask", "--agent", "home", "Hi"]);
 * expect(result.stdout).toContain("Hello");
 * await harness.cleanup();
 * ```
 */
export const startHarness = async (
  options: HarnessOptions = {}
): Promise<Harness> => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "wheatley-e2e-"));
  const llm = createFakeLlm(options.llm);
  const frontend = createFakeFrontend();
  const sessions = new Set<RpcSession>();
  const agents = options.agents ?? { [DEFAULT_AGENT]: {} };

  const config: DeploymentConfig = {
    ...options.config,
    agents: Object.fromEntries(
      Object.entries(agents).map(([name, agent]) => [
        name,
        fullAgentConfig(llm, agent),
      ])
    ),
    version: 1,
  };

  await writeFile(path.join(homeDir, "config.yaml"), stringify(config));
  await writeFile(
    path.join(homeDir, "secrets.yaml"),
    stringify(options.secrets ?? {}),
    { mode: 0o600 }
  );
  await options.prepare?.(homeDir);

  const dashboardDir =
    options.dashboardDir === undefined
      ? await builtDashboard()
      : (options.dashboardDir ?? undefined);

  const start = async (): Promise<WheatleyDaemon> => {
    const daemon = await startWheatley({
      catalog: { frontends: options.frontends ?? [frontend.frontend] },
      env: {},
      homeDir,
      models: async () => {
        await Promise.resolve();

        return llm.models;
      },
      port: 0,
      host: "127.0.0.1",
      staticDir: dashboardDir,
      version: E2E_VERSION,
    });

    await waitFor(
      () =>
        daemon.deployment
          .status()
          .agents.every((agent) => agent.state !== "starting")
          ? true
          : undefined,
      "every Agent to leave the starting state"
    );

    return daemon;
  };

  let daemon: WheatleyDaemon | undefined = await start();

  const running = (): WheatleyDaemon => {
    if (daemon === undefined) {
      throw new Error("The harness daemon is stopped");
    }

    return daemon;
  };

  const httpUrl = (): string => `http://127.0.0.1:${running().server.port}`;
  const wsUrl = (): string => `ws://127.0.0.1:${running().server.port}/ws`;

  const connect = async (): Promise<RpcSession> => {
    const client = await DaemonClient.connect({ url: wsUrl() }, E2E_VERSION);
    const events: RpcEvent[] = [];
    const waiters = new Set<() => void>();

    client.onEvent((event) => {
      events.push(event);

      for (const waiter of waiters) {
        waiter();
      }
    });
    await client.request("events.subscribe", {});

    const session: RpcSession = {
      client,
      close: async () => {
        sessions.delete(session);
        await client.close();
      },
      events,
      request: client.request,
      waitForEvent: async (name, predicate, timeoutMs = DEFAULT_WAIT_MS) => {
        const find = (): EventPayload<typeof name> | undefined => {
          for (const event of events) {
            if (
              isEventOf(event, name) &&
              (predicate === undefined || predicate(event.payload))
            ) {
              return event.payload;
            }
          }

          return undefined;
        };

        return await waitFor(find, `the event ${name}`, timeoutMs);
      },
    };

    sessions.add(session);

    return session;
  };

  const cliSession: Harness["cliSession"] = (argv, sessionOptions = {}) => {
    const input = lineQueue([], false);
    const out: string[] = [];
    const err: string[] = [];

    const result = (async (): Promise<CliResult> => {
      const code = await runCli(
        ["--home", homeDir, ...argv],
        ioFor(input, sessionOptions.isTTY ?? false, out, err),
        { ops: options.ops }
      );

      return { code, stderr: err.join(""), stdout: out.join("") };
    })();

    return {
      end: input.end,
      result,
      stderr: () => err.join(""),
      stdout: () => out.join(""),
      waitForOutput: async (pattern, timeoutMs = DEFAULT_WAIT_MS) => {
        await waitFor(
          () => (pattern.test(out.join("")) ? true : undefined),
          `CLI output ${pattern}`,
          timeoutMs
        );
      },
      write: input.push,
    };
  };

  const cli: Harness["cli"] = async (argv, cliOptions = {}) => {
    const input = lineQueue(cliOptions.input ?? [], true);
    const out: string[] = [];
    const err: string[] = [];

    const code = await runCli(
      ["--home", homeDir, ...argv],
      ioFor(input, cliOptions.isTTY ?? false, out, err),
      { ops: options.ops }
    );

    return { code, stderr: err.join(""), stdout: out.join("") };
  };

  const stop = async (): Promise<void> => {
    await Promise.all(
      [...sessions].map(async (session) => {
        await session.close();
      })
    );

    const current = daemon;

    daemon = undefined;
    await current?.close();
  };

  return {
    agentDir: (name = DEFAULT_AGENT) => path.join(homeDir, "agents", name),
    cleanup: async () => {
      await stop();
      await rm(homeDir, { force: true, recursive: true });
    },
    cli,
    cliSession,
    connect,
    daemon: running,
    frontend,
    homeDir,
    httpUrl,
    llm,
    restart: async () => {
      await stop();
      daemon = await start();
    },
    stop,
    workspaceDir: (name = DEFAULT_AGENT) =>
      path.join(homeDir, "agents", name, "workspace"),
    wsUrl,
  };
};

/** The Chat ID of every Agent's CLI Chat. */
export { CLI_CHAT_ID } from "../../src/core/agent/agent.js";

/** Creates a folder inside the home folder, for example `skills/<name>` before the daemon starts. */
export const ensureDir = async (...segments: string[]): Promise<string> => {
  const dir = path.join(...segments);

  await mkdir(dir, { recursive: true });

  return dir;
};
