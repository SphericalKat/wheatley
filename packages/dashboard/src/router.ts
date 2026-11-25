/** A Deployment-wide view in the sidebar. */
export type DeploymentView = "overview" | "inbox" | "logs" | "secrets";

/** A view of one Agent in the sidebar. */
export type AgentView = "chat" | "runs" | "memory" | "triggers" | "config";

/** The page that the dashboard shows. The URL hash holds it, so a reload or a shared link opens the same page. */
export type Route =
  | { readonly view: DeploymentView }
  | { readonly view: AgentView; readonly agent: string };

export const DEPLOYMENT_VIEWS: readonly DeploymentView[] = [
  "overview",
  "inbox",
  "logs",
  "secrets",
];

export const AGENT_VIEWS: readonly AgentView[] = [
  "chat",
  "runs",
  "memory",
  "triggers",
  "config",
];

const DEFAULT_ROUTE: Route = { view: "overview" };

const isDeploymentView = (name: string): name is DeploymentView =>
  DEPLOYMENT_VIEWS.some((view) => view === name);

const isAgentView = (name: string): name is AgentView =>
  AGENT_VIEWS.some((view) => view === name);

/** Reads a route from a URL hash such as `#/agents/home/chat`. Unknown hashes open the Overview. */
export const parseRoute = (hash: string): Route => {
  const parts = hash.replace(/^#\/?/u, "").split("/").map(decodeURIComponent);
  const [first = "", agent, view = "chat"] = parts;

  if (isDeploymentView(first)) {
    return { view: first };
  }

  if (
    first === "agents" &&
    agent !== undefined &&
    agent !== "" &&
    isAgentView(view)
  ) {
    return { agent, view };
  }

  return DEFAULT_ROUTE;
};

/** Writes a route as a URL hash. */
export const formatRoute = (route: Route): string =>
  "agent" in route
    ? `#/agents/${encodeURIComponent(route.agent)}/${route.view}`
    : `#/${route.view}`;
