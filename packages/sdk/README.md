# @wheatley-ai/sdk

Types and helpers for writing [Wheatley](https://www.npmjs.com/package/@wheatley-ai/cli) plugins.

A plugin is an ESM module that Wheatley loads into the daemon. A plugin can give an agent new tools that the model can call. It can also add frontends, which connect the agent to a chat platform. The SDK has no runtime dependencies. Most of it is types.

```sh
npm install @wheatley-ai/sdk
```

## A first plugin

This plugin gives the agent one tool that looks up the weather. Tool input can be a [Zod 4](https://zod.dev) schema, or any other library that implements [Standard JSON Schema](https://standardschema.dev). `execute` gets the parsed and typed value.

```ts
import { definePlugin } from "@wheatley-ai/sdk";
import { z } from "zod";

export default definePlugin({
  apiVersion: 1,
  name: "weather",
  version: "1.0.0",

  setup: ({ log }) => ({
    tools: [
      {
        name: "forecast",
        description: "Get today's forecast for a city",
        inputSchema: z.object({ city: z.string() }),
        execute: async ({ city }, { signal }) => {
          const url = `https://wttr.in/${encodeURIComponent(city)}?format=3`;
          const res = await fetch(url, { signal });
          if (!res.ok) {
            log.warn("forecast request failed", { status: res.status });
            return {
              content: [{ type: "text", text: `No forecast for ${city}` }],
              isError: true,
            };
          }
          return { content: [{ type: "text", text: await res.text() }] };
        },
      },
    ],
  }),
});
```

Plain JSON Schema works too, if you would rather not add a dependency. In that case `execute` receives an untyped JSON value:

```ts
inputSchema: {
  type: "object",
  properties: { city: { type: "string" } },
  required: ["city"],
},
```

## Loading it

Wheatley loads plugins per agent, from `config.yaml`. `source` is either a path or the name of a package installed in `~/.wheatley/extensions`.

```yaml
agents:
  default:
    plugins:
      - source: ./plugins/weather.js # relative to ~/.wheatley
      - source: wheatley-plugin-weather # from ~/.wheatley/extensions/node_modules
        config:
          units: metric
```

To install a plugin from npm:

```sh
npm install --prefix ~/.wheatley/extensions wheatley-plugin-weather
```

Restart the agent after you change its plugins. You can use `/restart` in a chat, or the button in the dashboard.

How Wheatley runs a plugin:

- The model sees the tool as `<plugin>:<tool>`, so the tool above is `weather:forecast`. Plugin names match `^[a-z][a-z0-9_-]*$`, and tool names match `^[a-z][a-z0-9_]*$`.
- Plugin tools need the user's approval by default. To skip that, add a rule to the agent's `permissionPolicy`, for example `{ tool: "weather:*", action: allow }`.
- If `setup` throws, Wheatley skips the plugin and shows the error in the agent's health. The agent still starts.
- Wheatley calls `setup` once for each agent that lists the plugin. Agents do not share plugin state.

## Configuration and secrets

Give the plugin a `configSchema`, and Wheatley validates the `config` block before it calls `setup`. Do not put secrets in `config`. Read them by name with `ctx.secrets`, which covers `secrets.yaml` and environment variables.

```ts
export default definePlugin({
  apiVersion: 1,
  name: "weather",
  version: "1.0.0",
  configSchema: z.object({ units: z.enum(["metric", "imperial"]) }),

  setup: ({ config, secrets, dataDir }) => {
    const apiKey = secrets.get("WEATHER_API_KEY");
    if (!apiKey) throw new Error("Set WEATHER_API_KEY in secrets.yaml");
    // config.units is "metric" | "imperial"
    // dataDir is a private folder for this plugin and agent
    return { tools: [/* ... */] };
  },
});
```

`setup` can also return a `dispose` function. Wheatley calls it when the agent stops or restarts. Use it to close connections or clear timers.

## Frontends

A frontend connects an agent to a chat platform. The built-in Telegram, Slack, and Discord frontends use the same contract.

```ts
import { definePlugin, type FrontendBinding } from "@wheatley-ai/sdk";
import { z } from "zod";

export default definePlugin({
  apiVersion: 1,
  name: "matrix",
  version: "1.0.0",

  setup: () => ({
    frontends: [
      {
        type: "matrix",
        configSchema: z.object({ room: z.string() }),
        createBinding: (config, ctx): FrontendBinding => ({
          // Connect, then hand incoming messages to Wheatley:
          //   await sink.send({ chatId, text, senderDisplayName })
          start: async (sink) => {},

          // Replies, approval prompts, and approval results arrive here.
          deliver: async (delivery) => {},

          stop: async () => {},
        }),
      },
    ],
  }),
});
```

The user then binds the frontend to an agent:

```yaml
agents:
  default:
    plugins:
      - source: wheatley-plugin-matrix
    frontends:
      - id: home
        type: matrix
        config:
          room: "!abc:example.org"
```

Rules for a frontend:

- Decide who may talk to the agent. The daemon trusts every message that a frontend sends to `sink`. The built-in frontends require an `allowedChatIds` list for this reason.
- If `deliver` fails, throw a `DeliveryError`. Use `kind: "retryable"` and Wheatley retries with backoff. Use `kind: "permanent"`, for example for a deleted chat, and Wheatley stops.
- `onEvent` is optional. It receives live progress, such as text deltas and tool calls. Use it to show a typing indicator, or to edit a message while the reply streams in.
- `sink.commands` lists the built-in chat commands, such as `/new` and `/stop`, so you can register them as native platform commands. `parseCommandText` turns `"/model gpt-5"` into a command.
- For a platform that pushes events over HTTP, `ctx.registerWebhookRoute` mounts a route on Wheatley's webhook server.

## Other exports

| Export | Use |
| --- | --- |
| `defineTool` | Define a tool outside `setup` and keep its input type |
| `chunkMarkdown` | Split a long Markdown reply into chunks that fit a platform's message limit |
| `isDeliveryError` | Check for a `DeliveryError`, including one from another copy of the SDK |
| `BUILTIN_COMMANDS` | The built-in chat commands, in menu order |
| `API_VERSION` | The plugin API version this SDK implements, currently `1` |

## Compatibility

`API_VERSION` is the plugin API version that the SDK implements. Wheatley skips a plugin whose `apiVersion` it does not support. While Wheatley is on `0.x`, a minor release can change the SDK types.

## License

ISC
