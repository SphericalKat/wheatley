import type { AgentState } from "@wheatley/protocol";
import type {
  SecretReader,
  WebhookResponse,
  WebhookRoute,
  WebhookRouteHandler,
} from "@wheatley/sdk";

import type { TriggerRuntime } from "./trigger-runtime.js";

/** The request body cap of the Webhook Ingress: 256 KiB (ADR 0010). */
export const MAX_WEBHOOK_BODY_BYTES = 262_144;

/**
 * One HTTP request after the listener read its body. The listener stops reading at `MAX_WEBHOOK_BODY_BYTES` and
 * answers `413` itself, so `handle` never sees a larger body.
 */
export interface IngressRequest {
  readonly method: string;
  /** The URL path without the query, for example `/webhooks/home/trigger-1`. */
  readonly path: string;
  /** Lowercase header names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

/** What the Ingress needs to know about one Agent. */
export interface IngressAgent {
  /**
   * The current Supervisor state of the Agent. The Ingress reads it on every request and answers `503` for any state
   * other than `running`. It does not throw.
   */
  readonly state: () => AgentState;
  /**
   * The Agent's Trigger runtime while the Agent is `running`, else `undefined`. A degraded Agent can lack the module,
   * and a stopped Agent has no open `agent.sqlite`.
   */
  readonly triggers: () =>
    | Pick<TriggerRuntime, "webhookTokenSecret" | "acceptWebhookEvent">
    | undefined;
}

/** What the Ingress needs from the Deployment. */
export interface WebhookIngressDeps {
  /** Resolves an Agent by name, or `undefined` for an unknown name. */
  readonly agent: (name: string) => IngressAgent | undefined;
  readonly secrets: SecretReader;
}

/**
 * The HTTP listener for Trigger webhooks and Frontend webhook routes (ADR 0010, ADR 0012). It is separate from the
 * localhost Control Server and stays off until `webhooks.enabled` is true.
 *
 * For `POST /webhooks/<agent>/<trigger-id>`, `handle` checks these conditions in this order:
 * 1. `405` for a method other than `POST`.
 * 2. `404` for an unknown Agent.
 * 3. `503` if the Agent is not `running` or has no Trigger runtime.
 * 4. `404` for an unknown Trigger, or a Trigger that is not an active `webhook` Trigger.
 * 5. `401` for a missing or wrong `Authorization: Bearer <token>`. The Ingress compares tokens with
 *    `crypto.timingSafeEqual`.
 * 6. `202` after `acceptWebhookEvent` resolved.
 *
 * `POST /frontends/<agent>/<binding-id>/<suffix>` goes to the handler that the Frontend registered. That handler
 * verifies the request itself. The Ingress answers `404` if no Frontend registered a handler for the path, and `503`
 * if the Agent is not `running`.
 */
export interface WebhookIngress {
  /** Routes one request. Resolves `500` without details if a handler or the Trigger runtime throws. */
  readonly handle: (request: IngressRequest) => Promise<WebhookResponse>;
  /**
   * Mounts a Frontend route. It backs `FrontendContext.registerWebhookRoute`. Throws if `pathSuffix` is empty,
   * contains `..` or `?`, or is already mounted for the binding.
   */
  readonly registerFrontendRoute: (
    agent: string,
    bindingId: string,
    pathSuffix: string,
    handler: WebhookRouteHandler
  ) => WebhookRoute;
}
