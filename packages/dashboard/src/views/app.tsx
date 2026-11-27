import {
  Link,
  Outlet,
  useNavigate,
  useParams,
  useRouterState,
} from "@tanstack/react-router";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import { useEffect, useState } from "react";

import { useServices, useStore } from "../hooks.js";
import { agentNames } from "../models/deployment.js";
import { ConflictBanner } from "./agent-admin.js";
import { Notice } from "./ui.js";

const DEPLOYMENT_LINKS = [
  { label: "Overview", to: "/overview" },
  { label: "Inbox", to: "/inbox" },
  { label: "Logs", to: "/logs" },
  { label: "Secrets", to: "/secrets" },
] as const;

const AGENT_LINKS = [
  { label: "Chat", to: "/agents/$agent/chat" },
  { label: "Runs", to: "/agents/$agent/runs" },
  { label: "Memory", to: "/agents/$agent/memory" },
  { label: "Triggers and Extensions", to: "/agents/$agent/triggers" },
  { label: "Config", to: "/agents/$agent/config" },
] as const;

type AgentPath = (typeof AGENT_LINKS)[number]["to"];

const LINK_CLASS =
  "flex items-center justify-between rounded-md px-3 py-1.5 text-sm no-underline";

const ACTIVE_LINK = {
  className: `${LINK_CLASS} bg-zinc-800 font-medium text-white`,
} as const;

const INACTIVE_LINK = {
  className: `${LINK_CLASS} text-zinc-300 hover:bg-zinc-800/60 hover:text-white`,
} as const;

/** Returns the Agent view in the URL, or `undefined` on a Deployment view. */
const useAgentPath = (): AgentPath | undefined => {
  const fullPath = useRouterState({
    select: (state) => state.matches.at(-1)?.fullPath,
  });

  return AGENT_LINKS.find((link) => link.to === fullPath)?.to;
};

const CONNECTION_COLORS = {
  closed: "bg-zinc-500",
  connecting: "bg-amber-400",
  incompatible: "bg-red-500",
  open: "bg-emerald-400",
  reconnecting: "bg-amber-400",
} as const;

const Sidebar = ({ agent }: { readonly agent: string | null }) => {
  const { client, deployment, inbox } = useServices();
  const navigate = useNavigate();
  const connection = useStore(client.state);
  const agents = agentNames(useStore(deployment.state));
  const { approvals, deliveries } = useStore(inbox.state);
  const inboxCount = approvals.length + deliveries.length;
  const agentPath = useAgentPath() ?? "/agents/$agent/chat";

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
          <Link
            activeProps={ACTIVE_LINK}
            inactiveProps={INACTIVE_LINK}
            key={link.to}
            to={link.to}
          >
            {link.label}
            {link.to === "/inbox" && inboxCount > 0 ? (
              <span className="rounded-full bg-amber-500 px-2 text-xs text-zinc-900">
                {inboxCount}
              </span>
            ) : null}
          </Link>
        ))}
      </div>
      <div className="space-y-2">
        <Select
          onValueChange={(value) => {
            if (value !== null) {
              void navigate({ params: { agent: value }, to: agentPath });
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
              <Link
                activeProps={ACTIVE_LINK}
                inactiveProps={INACTIVE_LINK}
                key={link.to}
                params={{ agent }}
                to={link.to}
              >
                {link.label}
              </Link>
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

/** The dashboard layout: a sidebar with Deployment views and an Agent switcher, and the page of the current URL. */
export const App = () => {
  const { deployment } = useServices();
  const routeAgent = useParams({ strict: false }).agent ?? null;
  const agents = agentNames(useStore(deployment.state));
  const [lastAgent, setLastAgent] = useState<string | null>(null);

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
      <Sidebar agent={agent} />
      <main className="flex-1 space-y-3 p-4 md:h-screen md:overflow-y-auto md:p-6">
        <ConnectionNotice />
        <ConflictBanner />
        <Outlet />
      </main>
    </div>
  );
};
