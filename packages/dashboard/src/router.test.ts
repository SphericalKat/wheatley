// @vitest-environment happy-dom
// Without a `document`, TanStack Router loads routes as a server render and does not follow redirects.
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import type { AgentHealth } from "@wheatley-ai/protocol";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, onTestFinished, test, vi } from "vitest";

import { ServicesContext } from "./hooks.js";
import { createConfigEditor } from "./models/config-editor.js";
import { createDeployment } from "./models/deployment.js";
import { createInbox } from "./models/inbox.js";
import { createLogTail } from "./models/logs.js";
import { createSecrets } from "./models/secrets.js";
import { createDashboardRouter } from "./router.js";
import { createRpcClient } from "./rpc/client.js";

/** Opens the dashboard router on a URL, as a direct load or a reload does, and returns it after redirects. */
const openAt = async (url: string) => {
  const router = createDashboardRouter(
    createMemoryHistory({ initialEntries: [url] })
  );

  await router.load();

  return router;
};

/** The URL that the dashboard shows and the route that renders it. */
const shown = (router: Awaited<ReturnType<typeof openAt>>) => ({
  params: router.state.matches.at(-1)?.params,
  path: router.state.location.pathname,
  route: router.state.matches.at(-1)?.fullPath,
});

test.each(["/overview", "/inbox", "/logs", "/secrets"])(
  "opens the Deployment view at %s",
  async (url) => {
    expect(shown(await openAt(url))).toEqual({
      params: {},
      path: url,
      route: url,
    });
  }
);

test.each(["chat", "runs", "memory", "triggers", "config"])(
  "opens the %s view of the Agent in the URL",
  async (view) => {
    expect(shown(await openAt(`/agents/home/${view}`))).toEqual({
      params: { agent: "home" },
      path: `/agents/home/${view}`,
      route: `/agents/$agent/${view}`,
    });
  }
);

test.each([
  "/",
  "/unknown",
  "/agents",
  "/agents/work/unknown",
  "/agents/work/chat/extra",
])("opens the Overview for the unknown or malformed URL %s", async (url) => {
  expect(shown(await openAt(url))).toEqual({
    params: {},
    path: "/overview",
    route: "/overview",
  });
});

test("opens the Chat of an Agent for a URL without a view", async () => {
  expect(shown(await openAt("/agents/work"))).toEqual({
    params: { agent: "work" },
    path: "/agents/work/chat",
    route: "/agents/$agent/chat",
  });
});

/** Renders the whole dashboard at a URL. The client never connects, so every view waits for the daemon. */
const renderAt = (url: string) => {
  const router = createDashboardRouter(
    createMemoryHistory({ initialEntries: [url] })
  );

  const client = createRpcClient({
    clientName: "router-test",
    clientVersion: "0.0.0",
    url: "ws://127.0.0.1:9/ws",
  });

  const services = {
    client,
    config: createConfigEditor(client),
    deployment: createDeployment(client),
    inbox: createInbox(client),
    logs: createLogTail(client),
    secrets: createSecrets(client),
  };

  const container = document.createElement("div");
  const root = createRoot(container);

  document.body.append(container);
  root.render(
    createElement(
      ServicesContext,
      { value: services },
      createElement(RouterProvider, { router })
    )
  );
  onTestFinished(() => {
    root.unmount();
    container.remove();
    client.close();
  });

  return { container, router, services };
};

test("opens the Overview for a URL with a broken percent escape", async () => {
  const { router } = renderAt("/agents/%E0%A4%A/chat");

  await vi.waitFor(() => {
    expect(router.state.location.pathname).toBe("/overview");
  });
});

test("moves to the view of a sidebar link in the same page", async () => {
  const { container, router } = renderAt("/overview");

  const link = await vi.waitFor(() => {
    const found = [...container.querySelectorAll("a")].find(
      (anchor) => anchor.textContent === "Logs"
    );

    expect(found?.getAttribute("href")).toBe("/logs");

    return found;
  });

  link?.click();

  await vi.waitFor(() => {
    expect(router.state.location.pathname).toBe("/logs");
    expect(link?.getAttribute("aria-current")).toBe("page");
  });
  expect(router.history.length).toBe(2);
});

/** The health of a running Agent without extensions. */
const runningAgent = (name: string): AgentHealth => ({
  activeRuns: 0,
  frontends: [],
  lastError: null,
  mcpServers: [],
  name,
  pendingRestart: false,
  plugins: [],
  restartBackoffMs: null,
  skillWarnings: [],
  state: "running",
});

test("keeps the view and changes the Agent in the URL when the Agent switcher selects another Agent", async () => {
  const { router, services } = renderAt("/agents/home/runs");

  services.deployment.state.update((current) => ({
    ...current,
    loading: false,
    status: {
      agents: [runningAgent("home"), runningAgent("work")],
      concurrency: [],
      protocolVersion: 1,
      startedAt: "2026-11-27T00:00:00.000Z",
      uptimeMs: 0,
      version: "test",
    },
  }));

  const trigger = await vi.waitFor(() => {
    const found = document.querySelector<HTMLElement>('[role="combobox"]');

    expect(found?.textContent).toContain("home");

    return found;
  });

  trigger?.click();

  const option = await vi.waitFor(() => {
    const found = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((element) => element.textContent === "work");

    expect(found).toBeDefined();

    return found;
  });

  option?.click();

  await vi.waitFor(() => {
    expect(shown(router)).toEqual({
      params: { agent: "work" },
      path: "/agents/work/runs",
      route: "/agents/$agent/runs",
    });
  });
  expect(router.history.length).toBe(2);
});

test("shows the view of each history entry on back and forward", async () => {
  const { container, router } = renderAt("/overview");

  // The router follows the history only after the dashboard mounts.
  await vi.waitFor(() => {
    expect(container.querySelector("nav")).not.toBeNull();
  });
  await router.navigate({ to: "/logs" });
  await router.navigate({
    params: { agent: "home" },
    to: "/agents/$agent/runs",
  });

  router.history.back();
  await vi.waitFor(() => {
    expect(shown(router)).toEqual({
      params: {},
      path: "/logs",
      route: "/logs",
    });
  });

  router.history.back();
  await vi.waitFor(() => {
    expect(shown(router)).toEqual({
      params: {},
      path: "/overview",
      route: "/overview",
    });
  });

  router.history.forward();
  router.history.forward();
  await vi.waitFor(() => {
    expect(shown(router)).toEqual({
      params: { agent: "home" },
      path: "/agents/home/runs",
      route: "/agents/$agent/runs",
    });
  });
});
