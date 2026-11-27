import {
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  redirect,
} from "@tanstack/react-router";
import type { RouterHistory } from "@tanstack/react-router";
import type { ComponentType } from "react";

import { App } from "./views/app.js";
import { ChatView } from "./views/chat.js";
import { ConfigView } from "./views/config.js";
import { InboxView } from "./views/inbox.js";
import { LogsView } from "./views/logs.js";
import { MemoryView } from "./views/memory.js";
import { OverviewView } from "./views/overview.js";
import { RunsView } from "./views/runs.js";
import { SecretsView } from "./views/secrets.js";
import { TriggersView } from "./views/triggers.js";

/** The matcher finds no route for a path that it cannot decode, such as `/agents/%E0/chat`. */
const OpenOverview = () => <Navigate replace to="/overview" />;

const rootRoute = createRootRoute({
  component: App,
  notFoundComponent: OpenOverview,
});

const overviewRoute = createRoute({
  component: OverviewView,
  getParentRoute: () => rootRoute,
  path: "overview",
});

const inboxRoute = createRoute({
  component: InboxView,
  getParentRoute: () => rootRoute,
  path: "inbox",
});

const logsRoute = createRoute({
  component: LogsView,
  getParentRoute: () => rootRoute,
  path: "logs",
});

const secretsRoute = createRoute({
  component: SecretsView,
  getParentRoute: () => rootRoute,
  path: "secrets",
});

const agentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "agents/$agent",
});

const agentIndexRoute = createRoute({
  beforeLoad: ({ params }) =>
    redirect({ params, replace: true, throw: true, to: "/agents/$agent/chat" }),
  getParentRoute: () => agentRoute,
  path: "/",
});

/** Renders an Agent view for the Agent in the URL. */
const agentPage = (View: ComponentType<{ readonly agent: string }>) => () => (
  <View agent={agentRoute.useParams().agent} />
);

/** A new Agent in the URL mounts the view again, so no state of the previous Agent stays on the page. */
const remountForAgent = ({
  params,
}: {
  readonly params: { readonly agent: string };
}): string => params.agent;

const chatRoute = createRoute({
  component: agentPage(ChatView),
  getParentRoute: () => agentRoute,
  path: "chat",
  remountDeps: remountForAgent,
});

const runsRoute = createRoute({
  component: agentPage(RunsView),
  getParentRoute: () => agentRoute,
  path: "runs",
  remountDeps: remountForAgent,
});

const memoryRoute = createRoute({
  component: agentPage(MemoryView),
  getParentRoute: () => agentRoute,
  path: "memory",
  remountDeps: remountForAgent,
});

const triggersRoute = createRoute({
  component: agentPage(TriggersView),
  getParentRoute: () => agentRoute,
  path: "triggers",
  remountDeps: remountForAgent,
});

const configRoute = createRoute({
  component: agentPage(ConfigView),
  getParentRoute: () => agentRoute,
  path: "config",
  remountDeps: remountForAgent,
});

/** Every URL that no other route matches, including `/`, opens the Overview. */
const fallbackRoute = createRoute({
  beforeLoad: () => redirect({ replace: true, throw: true, to: "/overview" }),
  getParentRoute: () => rootRoute,
  path: "$",
});

const routeTree = rootRoute.addChildren([
  fallbackRoute,
  overviewRoute,
  inboxRoute,
  logsRoute,
  secretsRoute,
  agentRoute.addChildren([
    agentIndexRoute,
    chatRoute,
    runsRoute,
    memoryRoute,
    triggersRoute,
    configRoute,
  ]),
]);

/** Creates the dashboard router. The browser passes its history, and tests pass a memory history. */
export const createDashboardRouter = (history: RouterHistory) =>
  createRouter({ history, routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createDashboardRouter>;
  }
}
