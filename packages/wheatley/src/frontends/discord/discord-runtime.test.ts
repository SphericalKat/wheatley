import { EventEmitter } from "node:events";

import * as discord from "discord.js";
import type { ChatInputApplicationCommandData } from "discord.js";
import { afterEach, expect, it, vi } from "vitest";

import { adaptClient } from "./discord-runtime.js";
import type { DiscordClient } from "./discord-runtime.js";

const COMMANDS: readonly ChatInputApplicationCommandData[] = [
  { description: "Start a new Conversation", name: "new" },
  { description: "Show the status", name: "status" },
];

let client: discord.Client | undefined;
let adapted: DiscordClient | undefined;

const adaptNewClient = () => {
  client = new discord.Client({ intents: [] });
  adapted = adaptClient(discord, client);

  return { api: adapted, raw: client };
};

/** A stand-in for the argument of one Gateway event: the client, an error, or a message or interaction. */
type GatewayPayload = discord.Client | Error | { readonly id: string };

/** Emits a Gateway event the way the discord.js WebSocket handlers do. */
const emit = (
  target: discord.Client,
  event: string,
  payload: GatewayPayload
): void => {
  EventEmitter.prototype.emit.call(target, event, payload);
};

afterEach(async () => {
  await adapted?.destroy();
  client = undefined;
  adapted = undefined;
});

it("routes discord.js client events to the adapter listeners", () => {
  const { api, raw } = adaptNewClient();
  const ready = vi.fn<() => void>();
  const messages: unknown[] = [];
  const interactions: unknown[] = [];
  const errors: Error[] = [];

  api.onReady(ready);
  api.onMessage((message) => {
    messages.push(message);
  });
  api.onInteraction((interaction) => {
    interactions.push(interaction);
  });
  api.onError((failure) => {
    errors.push(failure);
  });

  const message = { id: "m1" };
  const interaction = { id: "i1" };
  const failure = new Error("Gateway reconnect failed");

  emit(raw, discord.Events.ClientReady, raw);
  emit(raw, discord.Events.ClientReady, raw);
  emit(raw, discord.Events.MessageCreate, message);
  emit(raw, discord.Events.InteractionCreate, interaction);
  emit(raw, discord.Events.Error, failure);

  expect(ready).toHaveBeenCalledOnce();
  expect(messages).toStrictEqual([message]);
  expect(interactions).toStrictEqual([interaction]);
  expect(errors).toStrictEqual([failure]);
});

it("registers Slash Commands globally or per guild once the client is ready", async () => {
  const { api, raw } = adaptNewClient();

  await expect(api.setCommands(COMMANDS)).rejects.toThrow(/not ready/u);

  const set = vi.fn(
    async (
      commands: readonly ChatInputApplicationCommandData[],
      _guildId?: string
    ) => {
      await Promise.resolve();

      return new Map(commands.map((command) => [command.name, command]));
    }
  );

  Object.defineProperty(raw, "application", { value: { commands: { set } } });

  await expect(api.setCommands(COMMANDS)).resolves.toBe(COMMANDS.length);
  await expect(api.setCommands(COMMANDS, "700")).resolves.toBe(COMMANDS.length);
  expect(set.mock.calls).toStrictEqual([[COMMANDS], [COMMANDS, "700"]]);
});
