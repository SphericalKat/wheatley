import { existsSync } from "node:fs";
import path from "node:path";

import { serveStatic } from "@hono/node-server/serve-static";
import type { Context, Hono, MiddlewareHandler } from "hono";

/** The dashboard entry file. Paths without a file extension fall back to it, so the SPA can route itself. */
const INDEX_FILE = "index.html";

/** A Hono path pattern for every path whose last segment has no file extension, such as `/agents/foo/chat`. */
const SPA_ROUTE = "/:route{(?:[^/]+/)*[^/.]*}";

/** The file that `serveStatic` found for a request. */
const servedFiles = new WeakMap<Context, string>();

const recordFile = (file: string, c: Context): void => {
  servedFiles.set(c, file);
};

/**
 * Adds the cache and `nosniff` headers to a file response of `serve`. `serveStatic` builds its response before it
 * calls `onFound`, so headers that `onFound` sets do not reach the response.
 */
const withHeaders =
  (serve: MiddlewareHandler): MiddlewareHandler =>
  async (c, next) => {
    const response = await serve(c, next);
    const file = servedFiles.get(c);

    if (response instanceof Response && file !== undefined) {
      response.headers.set(
        "cache-control",
        path.basename(file) === INDEX_FILE ? "no-cache" : "max-age=3600"
      );
      response.headers.set("x-content-type-options", "nosniff");
    }

    return response;
  };

const passOn: MiddlewareHandler = async (_c, proceed) => {
  await proceed();
};

/**
 * Runs the handler that `create` builds while `root` exists, and passes the request on while it does not. It checks on
 * each request, so a dashboard built after the daemon starts is served without a restart. `serveStatic` logs an error
 * for a missing root when it is built, so `create` runs on the first request that finds the folder.
 */
const whileRootExists = (
  root: string,
  create: () => MiddlewareHandler
): MiddlewareHandler => {
  let created: MiddlewareHandler | undefined;

  return async (c, next) => {
    const handler = existsSync(root) ? (created ??= create()) : passOn;

    return await handler(c, next);
  };
};

/**
 * Serves `GET` and `HEAD` requests from the bundled dashboard folder on `app`. A path without a file extension that
 * matches no file serves the SPA entry. Requests that match no file fall through to the next handler, and so do all
 * requests while the folder is missing, for example in a source checkout without a built dashboard.
 *
 * The dashboard is static and holds no data. It reads everything over `/ws`, where the Control Server checks the
 * browser `Origin`.
 */
export const mountStaticFiles = (app: Hono, root: string): void => {
  const absolute = path.resolve(root);

  app.get(
    "*",
    whileRootExists(absolute, () =>
      withHeaders(serveStatic({ onFound: recordFile, root: absolute }))
    )
  );
  app.get(
    SPA_ROUTE,
    whileRootExists(absolute, () =>
      withHeaders(
        serveStatic({ onFound: recordFile, path: INDEX_FILE, root: absolute })
      )
    )
  );
};
