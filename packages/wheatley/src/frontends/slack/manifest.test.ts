import { BUILTIN_COMMANDS } from "@wheatley-ai/sdk";
import { describe, expect, it } from "vitest";

import { createSlackAppManifest } from "./manifest.js";

describe("createSlackAppManifest", () => {
  it("declares the seven built-in commands as native Slash Commands for Socket Mode", () => {
    const manifest = createSlackAppManifest({
      appName: "home",
      transport: "socket",
    });

    expect(manifest.features.slash_commands).toEqual(
      BUILTIN_COMMANDS.map((command) => ({
        command: `/${command.name}`,
        description: command.description,
        should_escape: false,
        url: undefined,
        usage_hint: "argument" in command ? command.argument : undefined,
      }))
    );
    expect(manifest.settings).toMatchObject({
      event_subscriptions: {
        bot_events: [
          "message.channels",
          "message.groups",
          "message.im",
          "message.mpim",
        ],
      },
      interactivity: { is_enabled: true },
      socket_mode_enabled: true,
    });
    expect(manifest.settings.event_subscriptions.request_url).toBeUndefined();
  });

  it("points events, commands, and interactivity at the webhook URL", () => {
    const requestUrl = "https://example.com/frontends/home/slack-main/events";

    const manifest = createSlackAppManifest({
      appName: "home",
      commands: [{ description: "Start over", name: "new" }],
      requestUrl,
      transport: "webhook",
    });

    expect(manifest.features.slash_commands).toEqual([
      {
        command: "/new",
        description: "Start over",
        should_escape: false,
        url: requestUrl,
        usage_hint: undefined,
      },
    ]);
    expect(manifest.settings.event_subscriptions.request_url).toBe(requestUrl);
    expect(manifest.settings.interactivity.request_url).toBe(requestUrl);
    expect(manifest.settings.socket_mode_enabled).toBe(false);
  });
});
