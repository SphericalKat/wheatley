import {
  DEFAULT_WEBHOOK_HOST,
  DEFAULT_WEBHOOK_PORT,
  webhookTriggerPath,
} from "@wheatley-ai/protocol";
import type { WebhooksConfig } from "@wheatley-ai/protocol";

/** Wildcard bind addresses and the loopback address of the same family that a local client can send requests to. */
const LOOPBACK_FOR_WILDCARD: ReadonlyMap<string, string> = new Map([
  ["0.0.0.0", "127.0.0.1"],
  ["::", "::1"],
]);

/** Where a webhook Trigger takes `POST` requests. */
export interface WebhookEndpoint {
  /** The request path, `/webhooks/<agent>/<triggerId>`. */
  readonly path: string;
  /** The full URL on the Webhook Ingress listener, or `null` if `webhooks.enabled` is not true and nothing listens. */
  readonly url: string | null;
}

/** Returns the URL host part of `host`, with brackets around an IPv6 address. */
const urlHost = (host: string): string =>
  host.includes(":") ? `[${host}]` : host;

/**
 * Returns the endpoint of the webhook Trigger `triggerId` of `agent`. `webhooks` is the `webhooks` block of the
 * loaded `config.yaml`. The URL names the listener address, which can differ from the address of a reverse proxy.
 * For a wildcard bind address (`0.0.0.0` or `::`), the URL names the loopback address of the same family.
 */
export const webhookEndpoint = (
  agent: string,
  triggerId: string,
  webhooks: WebhooksConfig | undefined
): WebhookEndpoint => {
  const path = webhookTriggerPath(agent, triggerId);

  if (webhooks?.enabled !== true) {
    return { path, url: null };
  }

  const bindHost = webhooks.host ?? DEFAULT_WEBHOOK_HOST;
  const host = urlHost(LOOPBACK_FOR_WILDCARD.get(bindHost) ?? bindHost);
  const port = webhooks.port ?? DEFAULT_WEBHOOK_PORT;

  return { path, url: `http://${host}:${port}${path}` };
};
