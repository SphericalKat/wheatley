import { timingSafeEqual } from "node:crypto";

import type {
  WebhookResponse,
  WebhookRoute,
  WebhookRouteHandler,
} from "@wheatley-ai/sdk";

import type {
  IngressRequest,
  WebhookIngress,
  WebhookIngressDeps,
} from "./webhook-ingress.js";

const BEARER = /^Bearer (?<token>.+)$/u;
const SAFE_SUFFIX = /^[A-Za-z0-9._~\-/]+$/u;

const status = (code: number): WebhookResponse => ({ status: code });

const tokensMatch = (given: string, expected: string): boolean => {
  const left = Buffer.from(given);
  const right = Buffer.from(expected);

  return left.length === right.length && timingSafeEqual(left, right);
};

/** An in-memory `WebhookIngress`: the routing and checks of the real one, without an HTTP listener. */
export class InMemoryWebhookIngress implements WebhookIngress {
  readonly #deps: WebhookIngressDeps;
  readonly #routes = new Map<string, WebhookRouteHandler>();

  constructor(deps: WebhookIngressDeps) {
    this.#deps = deps;
  }

  readonly registerFrontendRoute = (
    agent: string,
    bindingId: string,
    pathSuffix: string,
    handler: WebhookRouteHandler
  ): WebhookRoute => {
    if (
      pathSuffix === "" ||
      pathSuffix.includes("..") ||
      !SAFE_SUFFIX.test(pathSuffix)
    ) {
      throw new RangeError(`Invalid webhook path suffix: ${pathSuffix}`);
    }

    const path = `/frontends/${agent}/${bindingId}/${pathSuffix}`;

    if (this.#routes.has(path)) {
      throw new Error(`Webhook route already mounted: ${path}`);
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

    const [, area = "", agentName = "", target = "", ...rest] =
      request.path.split("/");

    const agent = this.#deps.agent(agentName);

    try {
      if (area === "webhooks" && rest.length === 0) {
        return await this.#trigger(agentName, target, request);
      }

      const handler =
        area === "frontends" ? this.#routes.get(request.path) : undefined;

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
        pathSuffix: rest.join("/"),
        query: request.query,
      });
    } catch {
      return status(500);
    }
  };

  readonly #trigger = async (
    agentName: string,
    triggerId: string,
    request: IngressRequest
  ): Promise<WebhookResponse> => {
    const agent = this.#deps.agent(agentName);

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

    const expected = this.#deps.secrets.get(secretName);

    const given = BEARER.exec(request.headers.authorization ?? "")?.groups
      ?.token;

    if (
      expected === undefined ||
      given === undefined ||
      !tokensMatch(given, expected)
    ) {
      return status(401);
    }

    const { authorization: _authorization, ...headers } = request.headers;
    await triggers.acceptWebhookEvent(triggerId, {
      body: request.body,
      headers,
      receivedAt: Date.now(),
    });

    return status(202);
  };
}
