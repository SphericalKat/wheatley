import { Server } from "node:http";

import { createAdaptorServer } from "@hono/node-server";

/** The `fetch` handler of a Hono app, which receives the `node:http` request and response as bindings. */
type FetchHandler = Parameters<typeof createAdaptorServer>[0]["fetch"];

/**
 * Creates a `node:http` server that answers with `fetch`. It does not listen yet. `name` names the listener in the
 * error that a server of another HTTP version causes.
 */
export const createHttpServer = (fetch: FetchHandler, name: string): Server => {
  const server = createAdaptorServer({
    fetch,
    // The default replaces the global `Request` and `Response` for the whole process.
    overrideGlobalObjects: false,
  });

  if (!(server instanceof Server)) {
    throw new TypeError(`The ${name} listener is not an HTTP/1.1 server`);
  }

  return server;
};
