import { expect, test } from "vitest";

import { webhookEndpoint } from "./triggers.js";

const TRIGGER_ID = "trigger-1";

test("gives the POST path and the default listener URL of a webhook Trigger", () => {
  expect(webhookEndpoint("home", TRIGGER_ID, { enabled: true })).toEqual({
    path: "/webhooks/home/trigger-1",
    url: "http://127.0.0.1:8788/webhooks/home/trigger-1",
  });
});

test("uses the configured webhook host and port in the URL", () => {
  expect(
    webhookEndpoint("home", TRIGGER_ID, {
      enabled: true,
      host: "::1",
      port: 9000,
    }).url
  ).toBe("http://[::1]:9000/webhooks/home/trigger-1");
});

test("names the loopback address if the ingress binds a wildcard address", () => {
  expect(
    webhookEndpoint("home", TRIGGER_ID, { enabled: true, host: "0.0.0.0" }).url
  ).toBe("http://127.0.0.1:8788/webhooks/home/trigger-1");
  expect(
    webhookEndpoint("home", TRIGGER_ID, { enabled: true, host: "::" }).url
  ).toBe("http://[::1]:8788/webhooks/home/trigger-1");
});

test("gives no URL while the Webhook Ingress is off", () => {
  expect(webhookEndpoint("home", TRIGGER_ID, { enabled: false })).toEqual({
    path: "/webhooks/home/trigger-1",
    url: null,
  });
  expect(webhookEndpoint("home", TRIGGER_ID, undefined).url).toBeNull();
});
