import { timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createAdaptorServer } from "@hono/node-server";
import type {
  Logger,
  WebhookResponse,
  WebhookRoute,
  WebhookRouteHandler,
} from "@wheatley-ai/sdk";
import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";

import { SeamError } from "../contracts/errors.js";
import type { Clock } from "../contracts/module.js";
import { MAX_WEBHOOK_BODY_BYTES } from "../contracts/webhook-ingress.js";
import type {
  IngressRequest,
  WebhookIngress,
  WebhookIngressDeps,
} from "../contracts/webhook-ingress.js";
import { errorText } from "./errors.js";

/** A request must arrive in full within this time. */
const REQUEST_TIMEOUT_MS = 30_000;

const BEARER = /^Bearer (?<token>\S+)$/u;
const SAFE_SUFFIX = /^[A-Za-z0-9._~\-/]+$/u;

/** The origin of the `Request` that `handle` builds. The Ingress routes on the path only. */
const INTERNAL_ORIGIN = "http://ingress.invalid";

const FRONTEND_PREFIX = /^\/frontends\/[^/]+\/[^/]+\//u;

const status = (code: number): WebhookResponse => ({ status: code });

const tokensMatch = (given: string, expected: string): boolean => {
  const left = Buffer.from(given);
  const right = Buffer.from(expected);

  return left.length === right.length && timingSafeEqual(left, right);
};

const toResponse = (result: WebhookResponse): Response =>
  new Response(
    result.body instanceof Uint8Array
      ? new Uint8Array(result.body)
      : result.body,
    { headers: result.headers, status: result.status }
  );

const fromResponse = async (response: Response): Promise<WebhookResponse> => {
  const body = new Uint8Array(await response.arrayBuffer());

  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    ...(body.byteLength > 0 && { body }),
  };
};

const isAddressInfo = (
  address: string | AddressInfo | null | undefined
): address is AddressInfo => typeof address === "object" && address !== null;

/** Options of the HTTP Webhook Ingress. */
export interface HttpWebhookIngressOptions extends WebhookIngressDeps {
  readonly clock: Clock;
  readonly log: Logger;
}

/** A routed request with its body read in full. */
interface ReadRequest {
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

const readRequest = async (c: Context): Promise<ReadRequest> => ({
  body: new Uint8Array(await c.req.arrayBuffer()),
  headers: Object.fromEntries(c.req.raw.headers),
  path: new URL(c.req.url).pathname,
  query: c.req.query(),
});

/**
 * The Webhook Ingress (ADR 0010, ADR 0012): the routing of `WebhookIngress` as a Hono app and a `node:http` listener
 * for it.
 *
 * The listener answers `413` for a body over 256 KiB as soon as the declared length or the streamed bytes pass the
 * cap, and closes the connection without reading the rest.
 */
export class HttpWebhookIngress implements WebhookIngress {
  readonly #options: HttpWebhookIngressOptions;
  readonly #routes = new Map<string, WebhookRouteHandler>();
  readonly #app: Hono;
  #server: Server | undefined;

  constructor(options: HttpWebhookIngressOptions) {
    this.#options = options;
    this.#app = this.#createApp();
  }

  readonly registerFrontendRoute = (
    agent: string,
    bindingId: string,
    pathSuffix: string,
    handler: WebhookRouteHandler
  ): WebhookRoute => {
    const invalid =
      pathSuffix === "" ||
      pathSuffix.includes("..") ||
      !SAFE_SUFFIX.test(pathSuffix);

    if (invalid) {
      throw new SeamError(
        "invalid_name",
        `Invalid webhook path suffix: ${pathSuffix}`
      );
    }

    const path = `/frontends/${agent}/${bindingId}/${pathSuffix}`;

    if (this.#routes.has(path)) {
      throw new SeamError("conflict", `Webhook route already mounted: ${path}`);
    }

    this.#routes.set(path, handler);

    return {
      path,
      unregister: () => {
        if (this.#routes.get(path) === handler) {
          this.#routes.delete(path);
        }
      },
    };
  };

  readonly handle = async (
    request: IngressRequest
  ): Promise<WebhookResponse> => {
    const url = new URL(request.path, INTERNAL_ORIGIN);

    for (const [name, value] of Object.entries(request.query)) {
      url.searchParams.set(name, value);
    }

    const hasBody = request.method !== "GET" && request.method !== "HEAD";

    const response = await this.#app.fetch(
      new Request(url, {
        body: hasBody ? new Uint8Array(request.body) : undefined,
        headers: request.headers,
        method: request.method,
      })
    );

    return await fromResponse(response);
  };

  /** The bound address while the listener runs, else `undefined`. */
  readonly address = (): AddressInfo | undefined => {
    const address = this.#server?.address();

    return isAddressInfo(address) ? address : undefined;
  };

  /** Starts the listener on `host` and `port`. Rejects if the port is in use. */
  readonly listen = async (host: string, port: number): Promise<void> => {
    const server = createAdaptorServer({
      fetch: this.#app.fetch,
      // The default replaces the global `Request` and `Response` for the whole process.
      overrideGlobalObjects: false,
    });

    if (!(server instanceof Server)) {
      throw new TypeError(
        "The Webhook Ingress listener is not an HTTP/1.1 server"
      );
    }

    server.requestTimeout = REQUEST_TIMEOUT_MS;

    server.listen(port, host);
    await once(server, "listening");
    this.#server = server;
  };

  /** Stops the listener and closes open connections. Resolves at once if the listener does not run. */
  readonly close = async (): Promise<void> => {
    const server = this.#server;
    this.#server = undefined;

    if (server === undefined) {
      return;
    }

    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  };

  readonly #createApp = (): Hono => {
    const app = new Hono();

    app.post(
      "*",
      bodyLimit({
        maxSize: MAX_WEBHOOK_BODY_BYTES,
        onError: (c) => c.body(null, 413, { connection: "close" }),
      })
    );
    app.post("/webhooks/:agent/:triggerId", async (c) =>
      toResponse(
        await this.#trigger(
          c.req.param("agent"),
          c.req.param("triggerId"),
          await readRequest(c)
        )
      )
    );
    app.post("/frontends/:agent/:bindingId/*", async (c) => {
      const request = await readRequest(c);

      return toResponse(
        await this.#frontend(
          c.req.param("agent"),
          request.path.replace(FRONTEND_PREFIX, ""),
          request
        )
      );
    });
    app.all("*", (c) => c.body(null, c.req.method === "POST" ? 404 : 405));
    app.onError((failure, c) => {
      this.#options.log.error("A webhook request failed", {
        error: errorText(failure),
        path: c.req.path,
      });

      return c.body(null, 500);
    });

    return app;
  };

  readonly #trigger = async (
    agentName: string,
    triggerId: string,
    request: ReadRequest
  ): Promise<WebhookResponse> => {
    const agent = this.#options.agent(agentName);

    if (agent === undefined) {
      return status(404);
    }

    const triggers = agent.state() === "running" ? agent.triggers() : undefined;

    if (triggers === undefined) {
      return status(503);
    }

    const secretName = await triggers.webhookTokenSecret(triggerId);

    if (secretName === undefined) {
      return status(404);
    }

    const expected = this.#options.secrets.get(secretName);

    const given = BEARER.exec(request.headers.authorization ?? "")?.groups
      ?.token;

    const authorized =
      expected !== undefined &&
      expected !== "" &&
      given !== undefined &&
      tokensMatch(given, expected);

    if (!authorized) {
      return status(401);
    }

    const { authorization: _authorization, ...headers } = request.headers;

    const { eventId } = await triggers.acceptWebhookEvent(triggerId, {
      body: request.body,
      headers,
      receivedAt: this.#options.clock.now(),
    });

    return {
      body: JSON.stringify({ eventId }),
      headers: { "content-type": "application/json" },
      status: 202,
    };
  };

  readonly #frontend = async (
    agentName: string,
    pathSuffix: string,
    request: ReadRequest
  ): Promise<WebhookResponse> => {
    const agent = this.#options.agent(agentName);
    const handler = this.#routes.get(request.path);

    if (agent === undefined || handler === undefined) {
      return status(404);
    }

    if (agent.state() !== "running") {
      return status(503);
    }

    return await handler({
      body: request.body,
      headers: request.headers,
      method: "POST",
      pathSuffix,
      query: request.query,
    });
  };
}
