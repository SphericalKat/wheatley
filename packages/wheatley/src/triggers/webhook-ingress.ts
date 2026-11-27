import { timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import type {
  Logger,
  WebhookResponse,
  WebhookRoute,
  WebhookRouteHandler,
} from "@wheatley-ai/sdk";
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { SeamError } from "../contracts/errors.js";
import type { Clock } from "../contracts/module.js";
import { MAX_WEBHOOK_BODY_BYTES } from "../contracts/webhook-ingress.js";
import type {
  IngressRequest,
  WebhookIngress,
  WebhookIngressDeps,
} from "../contracts/webhook-ingress.js";
import { createHttpServer } from "../core/server/http-server.js";
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

/**
 * The environment of the Ingress app. `handle` passes the body it got as the `body` binding, so the app does not read
 * it again. The `body` variable holds the request body for the routes.
 */
interface IngressEnv {
  readonly Bindings: { readonly body?: Uint8Array };
  readonly Variables: { readonly body: Uint8Array };
}

const readRequest = (c: Context<IngressEnv>): ReadRequest => ({
  body: c.get("body"),
  headers: Object.fromEntries(c.req.raw.headers),
  path: new URL(c.req.url).pathname,
  query: c.req.query(),
});

const noop = async (): Promise<void> => {
  await Promise.resolve();
};

/** An error that answers `code` with an empty body and closes the connection. */
const closingError = (code: ContentfulStatusCode): HTTPException =>
  new HTTPException(code, {
    res: new Response(null, { headers: { connection: "close" }, status: code }),
  });

const limitBody: MiddlewareHandler<IngressEnv> = bodyLimit({
  maxSize: MAX_WEBHOOK_BODY_BYTES,
  onError: () => {
    throw closingError(413);
  },
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
  readonly #app: Hono<IngressEnv>;
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

    const response = await this.#app.fetch(
      new Request(url, { headers: request.headers, method: request.method }),
      { body: request.body }
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
    const server = createHttpServer(this.#app.fetch, "Webhook Ingress");

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

  readonly #createApp = (): Hono<IngressEnv> => {
    const app = new Hono<IngressEnv>();

    app.post("*", async (c, proceed) => {
      c.set("body", c.env.body ?? (await this.#readBody(c)));
      await proceed();
    });
    app.post("/webhooks/:agent/:triggerId", async (c) =>
      toResponse(
        await this.#trigger(
          c.req.param("agent"),
          c.req.param("triggerId"),
          readRequest(c)
        )
      )
    );
    app.post("/frontends/:agent/:bindingId/*", async (c) => {
      const request = readRequest(c);

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
      if (failure instanceof HTTPException) {
        return failure.getResponse();
      }

      this.#options.log.error("A webhook request failed", {
        error: errorText(failure),
        path: c.req.path,
      });

      return c.body(null, 500);
    });

    return app;
  };

  /**
   * Reads the body of a listener request. Throws an `HTTPException` that answers `413` past the cap, or `400` for a
   * body that cannot be read, for example after the client aborts. Handler failures answer `500` in `onError`.
   */
  readonly #readBody = async (
    c: Context<IngressEnv, string>
  ): Promise<Uint8Array> => {
    try {
      await limitBody(c, noop);

      return new Uint8Array(await c.req.arrayBuffer());
    } catch (error) {
      if (error instanceof HTTPException) {
        throw error;
      }

      this.#options.log.warn("A webhook request was not read", {
        error: errorText(error),
      });

      throw closingError(400);
    }
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
