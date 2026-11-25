import {
  Select,
  SelectContent,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";

import { useServices, useStore } from "../hooks.js";
import { agentNames } from "../models/deployment.js";
import { formatRoute, parseRoute } from "../router.js";
import type { AgentView, DeploymentView, Route } from "../router.js";
import { ConflictBanner } from "./agent-admin.js";
import { ChatView } from "./chat.js";
import { ConfigView } from "./config.js";
import { InboxView } from "./inbox.js";
import { LogsView } from "./logs.js";
import { MemoryView } from "./memory.js";
import { OverviewView } from "./overview.js";
import { RunsView } from "./runs.js";
import { SecretsView } from "./secrets.js";
import { TriggersView } from "./triggers.js";
import { Notice } from "./ui.js";

const DEPLOYMENT_LINKS: readonly { view: DeploymentView; label: string }[] = [
  { label: "Overview", view: "overview" },
  { label: "Inbox", view: "inbox" },
  { label: "Logs", view: "logs" },
  { label: "Secrets", view: "secrets" },
];

const AGENT_LINKS: readonly { view: AgentView; label: string }[] = [
  { label: "Chat", view: "chat" },
  { label: "Runs", view: "runs" },
  { label: "Memory", view: "memory" },
  { label: "Triggers and Extensions", view: "triggers" },
  { label: "Config", view: "config" },
];

const subscribeToHash = (listener: () => void): (() => void) => {
  globalThis.addEventListener("hashchange", listener);

  return () => {
    globalThis.removeEventListener("hashchange", listener);
  };
};

const readHash = (): string => globalThis.location.hash;

/** Returns the route in the URL hash and renders again when it changes. */
const useRoute = (): Route =>
  parseRoute(useSyncExternalStore(subscribeToHash, readHash));

const navigate = (route: Route): void => {
  globalThis.location.hash = formatRoute(route);
};

const NavLink = ({
  active,
  children,
  route,
}: {
  readonly active: boolean;
  readonly route: Route;
  readonly children: ReactNode;
}) => (
  <a
    aria-current={active ? "page" : undefined}
    className={`flex items-center justify-between rounded-md px-3 py-1.5 text-sm no-underline ${
      active
        ? "bg-zinc-800 font-medium text-white"
        : "text-zinc-300 hover:bg-zinc-800/60 hover:text-white"
    }`}
    href={formatRoute(route)}
  >
    {children}
  </a>
);

const CONNECTION_COLORS = {
  closed: "bg-zinc-500",
  connecting: "bg-amber-400",
  incompatible: "bg-red-500",
  open: "bg-emerald-400",
  reconnecting: "bg-amber-400",
} as const;

const Sidebar = ({
  agent,
  route,
}: {
  readonly route: Route;
  readonly agent: string | null;
}) => {
  const { client, deployment, inbox } = useServices();
  const connection = useStore(client.state);
  const agents = agentNames(useStore(deployment.state));
  const { approvals, deliveries } = useStore(inbox.state);
  const inboxCount = approvals.length + deliveries.length;
  const agentView = "agent" in route ? route.view : "chat";

  return (
    <nav className="flex w-full flex-col gap-4 bg-zinc-900 p-3 text-zinc-100 md:h-screen md:w-60 md:shrink-0 md:overflow-y-auto">
      <div className="flex items-center justify-between px-2">
        <span className="text-lg font-semibold">Wheatley</span>
        <span
          className="flex items-center gap-1.5 text-xs text-zinc-400"
          title={connection.lastError ?? undefined}
        >
          <span
            className={`h-2 w-2 rounded-full ${CONNECTION_COLORS[connection.status]}`}
          />
          {connection.status}
        </span>
      </div>
      <div className="space-y-1">
        <p className="px-3 text-xs font-semibold tracking-wide text-zinc-500 uppercase">
          Deployment
        </p>
        {DEPLOYMENT_LINKS.map((link) => (
          <NavLink
            active={route.view === link.view}
            key={link.view}
            route={{ view: link.view }}
          >
            {link.label}
            {link.view === "inbox" && inboxCount > 0 ? (
              <span className="rounded-full bg-amber-500 px-2 text-xs text-zinc-900">
                {inboxCount}
              </span>
            ) : null}
          </NavLink>
        ))}
      </div>
      <div className="space-y-2">
        <Select
          onValueChange={(value) => {
            if (value !== null) {
              navigate({ agent: value, view: agentView });
            }
          }}
          value={agent}
        >
          <SelectLabel className="px-3 text-xs font-semibold tracking-wide text-zinc-500 uppercase">
            Agent
          </SelectLabel>
          <SelectTrigger className="flex w-full items-center justify-between rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100">
            <SelectValue placeholder="No Agents" />
          </SelectTrigger>
          <SelectContent className="w-(--anchor-width) rounded-md border border-zinc-700 bg-zinc-800 p-1 text-sm text-zinc-100 shadow-lg">
            {agents.map((name) => (
              <SelectItem
                className="cursor-default rounded px-2 py-1 data-[highlighted]:bg-zinc-700 data-[selected]:font-semibold"
                key={name}
                value={name}
              >
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {agent === null
          ? null
          : AGENT_LINKS.map((link) => (
              <NavLink
                active={"agent" in route && route.view === link.view}
                key={link.view}
                route={{ agent, view: link.view }}
              >
                {link.label}
              </NavLink>
            ))}
      </div>
      <p className="mt-auto px-2 text-xs text-zinc-500">
        {connection.wheatleyVersion === null
          ? ""
          : `Daemon ${connection.wheatleyVersion}`}
      </p>
    </nav>
  );
};

const AgentPage = ({
  agent,
  view,
}: {
  readonly agent: string;
  readonly view: AgentView;
}) => {
  if (view === "chat") {
    return <ChatView agent={agent} />;
  }

  if (view === "runs") {
    return <RunsView agent={agent} />;
  }

  if (view === "memory") {
    return <MemoryView agent={agent} />;
  }

  if (view === "triggers") {
    return <TriggersView agent={agent} />;
  }

  return <ConfigView agent={agent} />;
};

const DeploymentPage = ({ view }: { readonly view: DeploymentView }) => {
  if (view === "inbox") {
    return <InboxView />;
  }

  if (view === "logs") {
    return <LogsView />;
  }

  if (view === "secrets") {
    return <SecretsView />;
  }

  return <OverviewView />;
};

const ConnectionNotice = () => {
  const { client } = useServices();
  const { lastError, status } = useStore(client.state);

  if (status === "open" || status === "connecting") {
    return null;
  }

  if (status === "incompatible") {
    return (
      <Notice>
        {lastError ?? "The daemon speaks another protocol version."} Update the
        dashboard or the daemon.
      </Notice>
    );
  }

  return (
    <Notice>
      The connection to the daemon is lost. The dashboard reconnects by itself.
      {lastError === null ? "" : ` (${lastError})`}
    </Notice>
  );
};

/** The dashboard: a sidebar with Deployment views and an Agent switcher, and the page of the current route. */
export const App = () => {
  const { deployment } = useServices();
  const route = useRoute();
  const agents = agentNames(useStore(deployment.state));
  const [lastAgent, setLastAgent] = useState<string | null>(null);
  const routeAgent = "agent" in route ? route.agent : null;

  useEffect(() => {
    if (routeAgent !== null) {
      setLastAgent(routeAgent);
    }
  }, [routeAgent]);

  const remembered =
    lastAgent !== null && agents.includes(lastAgent) ? lastAgent : null;

  const agent = routeAgent ?? remembered ?? agents[0] ?? null;

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 text-zinc-900 md:flex-row dark:bg-zinc-950 dark:text-zinc-100">
      <Sidebar agent={agent} route={route} />
      <main className="flex-1 space-y-3 p-4 md:h-screen md:overflow-y-auto md:p-6">
        <ConnectionNotice />
        <ConflictBanner />
        {"agent" in route ? (
          <AgentPage agent={route.agent} key={route.agent} view={route.view} />
        ) : (
          <DeploymentPage view={route.view} />
        )}
      </main>
    </div>
  );
};
