import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import packageJson from "../package.json" with { type: "json" };
import type { Services } from "./hooks.js";
import { ServicesContext } from "./hooks.js";
import { createConfigEditor } from "./models/config-editor.js";
import { createDeployment } from "./models/deployment.js";
import { createInbox } from "./models/inbox.js";
import { createLogTail } from "./models/logs.js";
import { createSecrets } from "./models/secrets.js";
import { createRpcClient, dashboardSocketUrl } from "./rpc/client.js";
import { App } from "./views/app.js";

import "./styles.css";

const client = createRpcClient({
  clientName: "wheatley-dashboard",
  clientVersion: packageJson.version,
  url: dashboardSocketUrl(new URL(globalThis.location.href)),
});

const services: Services = {
  client,
  config: createConfigEditor(client),
  deployment: createDeployment(client),
  inbox: createInbox(client),
  logs: createLogTail(client),
  secrets: createSecrets(client),
};

client.connect();

const root = document.querySelector("#root");

if (root === null) {
  throw new Error("index.html has no #root element");
}

createRoot(root).render(
  <StrictMode>
    <ServicesContext value={services}>
      <App />
    </ServicesContext>
  </StrictMode>
);
