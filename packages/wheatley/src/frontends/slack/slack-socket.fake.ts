import type { JsonObject } from "@wheatley/sdk";

import type {
  SlackSdk,
  SlackSocketClient,
  SlackSocketEnvelope,
} from "./slack-client.js";
import type { FakeSlackWebClient } from "./slack-web.fake.js";

/** A fake `SocketModeClient`. `emit` plays one envelope from Slack and reports whether the binding acknowledged it. */
export class FakeSlackSocketClient implements SlackSocketClient {
  readonly #listeners: ((envelope: SlackSocketEnvelope) => void)[] = [];
  started = false;
  disconnected = false;
  acks = 0;

  readonly on = (
    _event: "slack_event",
    listener: (envelope: SlackSocketEnvelope) => void
  ): void => {
    this.#listeners.push(listener);
  };

  readonly start = async () => {
    await Promise.resolve();
    this.started = true;

    return { ok: true };
  };

  readonly disconnect = async (): Promise<void> => {
    await Promise.resolve();
    this.disconnected = true;
  };

  readonly emit = (type: string, body: JsonObject): void => {
    const ack = async (): Promise<void> => {
      await Promise.resolve();
      this.acks += 1;
    };

    for (const listener of this.#listeners) {
      listener({ ack, body, type });
    }
  };
}

/** A `SlackSdk` that hands out one fake Web API client and one fake socket client. */
export const fakeSlackSdk = (
  web: FakeSlackWebClient,
  socket: FakeSlackSocketClient
): (() => Promise<SlackSdk>) => {
  const sdk: SlackSdk = {
    createSocketClient: () => socket,
    createWebClient: () => web,
  };

  return async () => {
    await Promise.resolve();

    return sdk;
  };
};
