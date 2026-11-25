import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, it } from "vitest";
import { WebSocket } from "ws";

import { startHarness, waitFor } from "./harness.js";
import type { Harness } from "./harness.js";

const DASHBOARD_HTML = "<!doctype html><title>Wheatley test dashboard</title>";

let harness: Harness;
let dashboardDir: string;

beforeEach(async () => {
  dashboardDir = await mkdtemp(path.join(tmpdir(), "wheatley-dashboard-"));
  await writeFile(path.join(dashboardDir, "index.html"), DASHBOARD_HTML);

  harness = await startHarness({
    agents: {
      home: {
        frontends: [
          {
            config: { allowedChatIds: ["chat-1"] },
            id: "fake-main",
            type: "fake",
          },
        ],
      },
    },
    dashboardDir,
  });
});

afterEach(async () => {
  await harness.cleanup();
  await rm(dashboardDir, { force: true, recursive: true });
});

/** Resolves the HTTP status of a WebSocket upgrade to `/ws` with `origin`. */
const upgradeStatus = async (url: string, origin: string): Promise<number> => {
  const socket = new WebSocket(url, { origin });
  const { promise, resolve } = Promise.withResolvers<number>();

  socket.once("open", () => {
    socket.close();
    resolve(101);
  });
  socket.once("unexpected-response", (_request, response) => {
    resolve(response.statusCode ?? 0);
    socket.terminate();
  });
  socket.once("error", () => {
    resolve(0);
  });

  return await promise;
};

it("runs an Agent on the real Harness and answers over the CLI, /ws, and a Frontend", async () => {
  const session = await harness.connect();
  const status = await session.request("system.status", {});

  expect(status.agents.map((agent) => [agent.name, agent.state])).toEqual([
    ["home", "running"],
  ]);
  expect(status.agents[0]?.frontends).toContainEqual({
    id: "fake-main",
    state: "ready",
    type: "fake",
  });

  harness.llm.faux.setResponses([fauxAssistantMessage("Hello from the CLI")]);
  const asked = await harness.cli(["ask", "--agent", "home", "Say hello"]);

  expect(asked).toMatchObject({ code: 0 });
  expect(asked.stdout).toContain("Hello from the CLI");

  harness.llm.faux.setResponses([
    fauxAssistantMessage("Hello from the Frontend"),
  ]);
  await harness.frontend.send("home", "fake-main", "chat-1", "Hi there", "Ada");

  const binding = harness.frontend.binding("home", "fake-main");

  const reply = await waitFor(
    () => binding.deliveries.find((delivery) => delivery.kind === "message"),
    "the reply delivery"
  );

  expect(reply).toMatchObject({
    chatId: "chat-1",
    kind: "message",
    source: "reply",
    text: "Hello from the Frontend",
  });
  expect(binding.events.map((event) => event.kind)).toContain("run_started");
});

it("serves the dashboard on / and rejects /ws from a foreign Origin", async () => {
  const page = await fetch(`${harness.httpUrl()}/`);
  const route = await fetch(`${harness.httpUrl()}/agents/home`);

  expect(page.status).toBe(200);
  expect(await page.text()).toBe(DASHBOARD_HTML);
  expect(await route.text()).toBe(DASHBOARD_HTML);
  const escape = await fetch(`${harness.httpUrl()}/..%2f..%2fconfig.yaml`);

  expect(escape.status).toBe(404);

  expect(await upgradeStatus(harness.wsUrl(), "http://evil.example")).toBe(403);
  expect(await upgradeStatus(harness.wsUrl(), harness.httpUrl())).toBe(101);
});
