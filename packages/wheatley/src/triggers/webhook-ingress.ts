import { timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type {
  Logger,
  WebhookResponse,
  WebhookRoute,
  WebhookRouteHandler,
} from "@wheatley/sdk";

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

const status = (code: number): WebhookResponse => ({ status: code });

const tokensMatch = (given: string, expected: string): boolean => {
  const left = Buffer.from(given);
  const right = Buffer.from(expected);

  return left.length === right.length && timingSafeEqual(left, right);
};

const headersOf = (request: IncomingMessage) =>
  Object.fromEntries(
    Object.entries(request.headers).flatMap(([name, value]) =>
      value === undefined
        ? []
        : [[name, Array.isArray(value) ? value.join(", ") : value]]
    )
  );

/**
 * Reads the body and stops at `MAX_WEBHOOK_BODY_BYTES`. Resolves `undefined` as soon as the declared length or the
 * streamed bytes pass the cap, without reading the rest.
 */
const readBody = async (
  request: IncomingMessage
): Promise<Uint8Array | undefined> => {
  const declared = Number(request.headers["content-length"] ?? "0");

  if (declared > MAX_WEBHOOK_BODY_BYTES) {
    return undefined;
  }

  const chunks: Buffer[] = [];
  let size = 0;

  // The early return must not destroy the socket before the `413` answer.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;

    if (size > MAX_WEBHOOK_BODY_BYTES) {
      return undefined;
    }

    chunks.push(buffer);
  }

  return new Uint8Array(Buffer.concat(chunks));
};

const isAddressInfo = (
  address: string | AddressInfo | null | undefined
): address is AddressInfo => typeof address === "object" && address !== null;

/** Options of the HTTP Webhook Ingress. */
export interface HttpWebhookIngressOptions extends WebhookIngressDeps {
  readonly clock: Clock;
  readonly log: Logger;
}

/**
 * The Webhook Ingress (ADR 0010, ADR 0012): the routing of `WebhookIngress` and a `node:http` listener for it.
 *
 * The listener answers `413` for a body over 256 KiB as soon as the declared length or the streamed bytes pass the
 * cap, and closes the connection without reading the rest.
 */
export class HttpWebhookIngress implements WebhookIngress {
  readonly #options: HttpWebhookIngressOptions;
  readonly #routes = new Map<string, WebhookRouteHandler>();
  #server: Server | undefined;

  constructor(options: HttpWebhookIngressOptions) {
    this.#options = options;
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
    if (request.method !== "POST") {
      return status(405);
    }

    const [empty, area, agentName = "", target = "", ...rest] =
      request.path.split("/");

    if (empty !== "") {
      return status(404);
    }

    try {
      if (area === "webhooks" && rest.length === 0) {
        return await this.#trigger(agentName, target, request);
      }

      if (area === "frontends") {
        return await this.#frontend(agentName, rest.join("/"), request);
      }

      return status(404);
    } catch (error) {
      this.#options.log.error("A webhook request failed", {
        error: errorText(error),
        path: request.path,
      });

      return status(500);
    }
  };

  /** The bound address while the listener runs, else `undefined`. */
  readonly address = (): AddressInfo | undefined => {
    const address = this.#server?.address();

    return isAddressInfo(address) ? address : undefined;
  };

  /** Starts the listener on `host` and `port`. Rejects if the port is in use. */
  readonly listen = async (host: string, port: number): Promise<void> => {
    const server = createServer((request, response) => {
      void this.#serve(request, response);
    });

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

  readonly #trigger = async (
    agentName: string,
    triggerId: string,
    request: IngressRequest
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
    request: IngressRequest
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

  readonly #serve = async (
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://ingress.invalid");

    try {
      const body =
        request.method === "POST" ? await readBody(request) : new Uint8Array();

      if (body === undefined) {
        response.writeHead(413, { connection: "close" });
        response.end(() => {
          request.destroy();
        });

        return;
      }

      const result = await this.handle({
        body,
        headers: headersOf(request),
        method: request.method ?? "",
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
      });

      response.writeHead(result.status, result.headers);
      response.end(result.body);
    } catch (error) {
      this.#options.log.warn("A webhook request was not read", {
        error: errorText(error),
      });

      if (!response.headersSent) {
        response.writeHead(400, { connection: "close" });
      }

      response.end();
    }
  };
}
