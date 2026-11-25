import type { WebhooksConfig } from "@wheatley/protocol";

/** The Webhook Ingress host if `webhooks.host` is absent. It matches `DEFAULT_WEBHOOK_HOST` of the daemon. */
const DEFAULT_WEBHOOK_HOST = "127.0.0.1";

/** The Webhook Ingress port if `webhooks.port` is absent. It matches `DEFAULT_WEBHOOK_PORT` of the daemon. */
const DEFAULT_WEBHOOK_PORT = 8788;

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
 */
export const webhookEndpoint = (
  agent: string,
  triggerId: string,
  webhooks: WebhooksConfig | undefined
): WebhookEndpoint => {
  const path = `/webhooks/${encodeURIComponent(agent)}/${encodeURIComponent(triggerId)}`;

  if (webhooks?.enabled !== true) {
    return { path, url: null };
  }

  const host = urlHost(webhooks.host ?? DEFAULT_WEBHOOK_HOST);
  const port = webhooks.port ?? DEFAULT_WEBHOOK_PORT;

  return { path, url: `http://${host}:${port}${path}` };
};
