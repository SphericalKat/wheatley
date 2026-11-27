// @vitest-environment happy-dom
// Without a `document`, TanStack Router loads routes as a server render and does not follow redirects.
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
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

  return { container, router };
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
