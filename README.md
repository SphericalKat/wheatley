# Wheatley

Wheatley is a self-hosted, always-on personal AI assistant written in TypeScript. One Deployment hosts one or more Agents. Each Agent has its own model, Permission Policy, Memory, Triggers, and Conversations. You talk to an Agent from the CLI or from the web dashboard. Terms such as Deployment, Agent, Chat, Conversation, Run, and Approval follow [`GLOSSARY.md`](GLOSSARY.md).

## Requirements

- Node.js `26.13.1` or later. The repository pins `26.13.1` in `.node-version`.
- `pnpm` `12.23.0`, for a build from source.
- An API key for a model provider, for example Anthropic or OpenAI.
- Docker with Docker Compose, for the Docker install only.

## Install

Each release publishes these artifacts:

- The npm package [`@wheatley-ai/cli`](https://www.npmjs.com/package/@wheatley-ai/cli). It contains the daemon, the CLI, and the dashboard.
- The npm package [`@wheatley-ai/sdk`](https://www.npmjs.com/package/@wheatley-ai/sdk). It contains the Plugin and Frontend contracts.
- The Docker image `ghcr.io/sphericalkat/wheatley`.
- A GitHub release with a `v<version>` tag and the changelog.

### Install from npm

1. Install the latest release globally:

   ```bash
   npm install --global @wheatley-ai/cli
   ```

   With `pnpm`:

   ```bash
   pnpm add --global @wheatley-ai/cli
   ```

2. Check the installed version:

   ```bash
   npm list --global @wheatley-ai/cli
   ```

3. Continue with the [Quick start](#quick-start).

The package puts the `wheatley` command on your `PATH`. To install one version, add it to the package name, for example `@wheatley-ai/cli@0.1.0`.

### Run with Docker

The image is based on `node:26-trixie-slim`. The container keeps the Deployment home in the `/data` volume and runs `wheatley daemon`. Each release pushes these image tags:

| Tag                       | Points to                                       |
| ------------------------- | ----------------------------------------------- |
| `<major>.<minor>.<patch>` | One release, for example `0.1.0`.               |
| `<major>.<minor>`         | The newest patch release of that minor version. |
| `<major>`                 | The newest release of that major version.       |
| `latest`                  | The newest release.                             |

Before version `1.0.0`, a minor version can contain breaking changes.

1. If the image is private, log in to the GitHub Container Registry with a token that has the `read:packages` scope:

   ```bash
   docker login ghcr.io
   ```

2. Pull the latest image:

   ```bash
   docker pull ghcr.io/sphericalkat/wheatley:latest
   ```

3. Continue with [Docker Compose](#run-with-docker-compose) or [`docker run`](#run-with-docker-run).

### Run with Docker Compose

The Compose file in `docker/docker-compose.yml` uses the image tag in `WHEATLEY_TAG`. The default tag is `0`. The Compose file publishes port `7420` on `127.0.0.1` of the host only.

1. Open the `docker` folder:

   ```bash
   cd docker
   ```

2. Pull the image:

   ```bash
   docker compose pull
   ```

   To use another tag, set `WHEATLEY_TAG`, for example `WHEATLEY_TAG=latest docker compose pull`. Use the same value for each `docker compose` command.

3. Create `config.yaml` and `secrets.yaml` in `/data`:

   ```bash
   docker compose run --rm wheatley wheatley init
   ```

4. Make the Control Server listen on all container interfaces:

   ```bash
   docker compose run --rm wheatley sh -c 'printf "daemon:\n  host: 0.0.0.0\n  port: 7420\n" >> /data/config.yaml'
   ```

5. Add your API key to `secrets.yaml`:

   ```bash
   docker compose run --rm wheatley sh -c 'echo "ANTHROPIC_API_KEY: <your key>" >> /data/secrets.yaml'
   ```

6. Start the daemon:

   ```bash
   docker compose up -d
   ```

7. Open the dashboard at <http://127.0.0.1:7420/>.

To update, run these commands in the `docker` folder:

```bash
docker compose pull
docker compose up -d
```

To build the image from your checkout instead, run `docker compose build`.

### Run with `docker run`

Use these commands if you do not have the Compose file.

1. Create the volume for the Deployment home:

   ```bash
   docker volume create wheatley-data
   ```

2. Create `config.yaml` and `secrets.yaml`:

   ```bash
   docker run --rm -v wheatley-data:/data ghcr.io/sphericalkat/wheatley:latest wheatley init
   ```

3. Make the Control Server listen on all container interfaces:

   ```bash
   docker run --rm -v wheatley-data:/data ghcr.io/sphericalkat/wheatley:latest sh -c 'printf "daemon:\n  host: 0.0.0.0\n  port: 7420\n" >> /data/config.yaml'
   ```

4. Add your API key to `secrets.yaml`:

   ```bash
   docker run --rm -v wheatley-data:/data ghcr.io/sphericalkat/wheatley:latest sh -c 'echo "ANTHROPIC_API_KEY: <your key>" >> /data/secrets.yaml'
   ```

5. Start the daemon:

   ```bash
   docker run -d --name wheatley --init --restart unless-stopped --stop-timeout 45 \
     -p 127.0.0.1:7420:7420 -v wheatley-data:/data ghcr.io/sphericalkat/wheatley:latest
   ```

6. Open the dashboard at <http://127.0.0.1:7420/>.

To update, pull the image, then remove the container and start it again with the command in step 5:

```bash
docker pull ghcr.io/sphericalkat/wheatley:latest
docker rm --force wheatley
```

The Deployment home stays in the `wheatley-data` volume.

### Build from source

1. Clone the repository and open its folder.
2. Install the dependencies:

   ```bash
   pnpm install
   ```

3. Build every package and the dashboard:

   ```bash
   pnpm build
   ```

4. Run the CLI:

   ```bash
   node packages/wheatley/bin/wheatley.js --help
   ```

The examples below use `wheatley`. In a source checkout, use `node packages/wheatley/bin/wheatley.js` instead.

### Install from a tarball

1. Build from source, as shown above.
2. Pack the package in the repository root. The `prepack` script builds it again:

   ```bash
   pnpm --filter @wheatley-ai/cli pack
   ```

3. Install the tarball:

   ```bash
   npm install --global ./wheatley-ai-cli-<version>.tgz
   ```

## Quick start

1. Create the Deployment home. The default home is `$WHEATLEY_HOME`, else `~/.wheatley`:

   ```bash
   wheatley init
   ```

2. Set the API key. Edit `~/.wheatley/secrets.yaml` and add this line:

   ```yaml
   ANTHROPIC_API_KEY: <your key>
   ```

3. Start the daemon in the foreground:

   ```bash
   wheatley daemon
   ```

4. In a second terminal, check the health of the Deployment:

   ```bash
   wheatley status
   ```

5. Send one prompt:

   ```bash
   wheatley ask "What can you do?"
   ```

6. Start an interactive Chat:

   ```bash
   wheatley chat
   ```

### What `wheatley init` creates

`wheatley init` writes these files in the Deployment home:

- `config.yaml`: the Deployment settings.
- `secrets.yaml`: secret values, with file mode `0600`.
- `agents/<name>/`: the folder of the first Agent.

`wheatley init` never overwrites an existing `config.yaml`. It accepts these options:

- `--home <dir>`: the Deployment home.
- `--agent <name>`: the name of the first Agent. The default is `default`.
- `--provider <name>`: the model provider. The default is `anthropic`.
- `--model <id>`: the model ID. The default is `claude-sonnet-5-5`.

The API key secret is `<PROVIDER>_API_KEY`, for example `OPENAI_API_KEY` for `--provider openai`. Set it in `secrets.yaml` or as an environment variable. An environment variable wins over the value in `secrets.yaml`.

If the API key secret is not set, the daemon starts, but the Agent is `degraded`. `wheatley status` then shows "The API key secret ... is not set".

### Daemon listeners

`wheatley daemon` listens on two endpoints:

- The Unix socket `<home>/daemon.sock`. The CLI uses this socket by default.
- A TCP listener on `127.0.0.1:7420`. This listener serves the dashboard on `/` and JSON-RPC on `/ws`.

To use another TCP address, set `daemon.host` and `daemon.port` in `config.yaml`, or pass `--host` and `--port`. To connect the CLI over TCP, pass `--url ws://127.0.0.1:7420/ws`.

## Configuration

`config.yaml` holds the Deployment settings. `secrets.yaml` holds secret values. `config.yaml` refers to a secret by name only. After you edit `config.yaml`, restart the changed Agent. Wheatley does not restart an Agent on its own.

### Model provider

Wheatley uses the built-in providers of pi-ai, for example `anthropic`, `openai`, `google`, `openrouter`, `groq`, `mistral`, `xai`, and `deepseek`. The model ID must exist in the pi-ai model registry. An unknown model ID fails.

```yaml
version: 1

providers:
  anthropic:
    apiKey:
      secret: ANTHROPIC_API_KEY

agents:
  default:
    model:
      provider: anthropic
      id: claude-sonnet-5-5
```

To use an OpenAI-compatible proxy, set `baseUrl` on the `openai` provider. Use an OpenAI model ID that pi-ai knows:

```yaml
providers:
  openai:
    baseUrl: https://<host>/v1
    apiKey:
      secret: OPENAI_API_KEY

agents:
  default:
    model:
      provider: openai
      id: gpt-5.4-mini
```

### Permission Policy

The `permissionPolicy` of an Agent is an ordered list of rules. Each rule names a Tool and an action: `allow`, `ask`, or `deny`. The first matching rule wins. A `*` in the Tool name matches any text.

```yaml
agents:
  default:
    permissionPolicy:
      - tool: read_file
        action: allow
      - tool: shell
        action: deny
```

Without a matching rule, a Tool uses its default action:

| Tool | Default action |
| --- | --- |
| `read_file` | `allow` |
| `write_file`, `shell` | `ask` |
| `memory_search`, `memory_read`, `memory_write`, `memory_delete` | `allow` |
| `schedule_trigger`, `list_triggers`, `cancel_trigger` | `allow` |
| MCP Server Tools (`mcp:<server>:<tool>`) | `ask` |

The Tools work in the folder `agents/<name>/workspace`.

An Approval waits 15 minutes by default. To change this time, set `approvalTimeout`, for example `30m`. To wait without a limit, set `approvalTimeout: null`.

### Webhooks

The Webhook Ingress is off by default. To turn it on, add this block to `config.yaml` and restart the daemon:

```yaml
webhooks:
  enabled: true
  port: 8788
```

The default host is `127.0.0.1`, and the default port is `8788`.

## Chat and Approvals

`wheatley ask "<prompt>"` sends one prompt and prints the reply. `ask` also reads the prompt from standard input. If standard input is not a terminal, `ask` denies each Tool call that needs an Approval.

`wheatley chat` opens the CLI Chat of an Agent. The dashboard shows the same Chat. If the Deployment has more than one Agent and none has the name `default`, pass `--agent <name>`. Type `/exit` or press `Ctrl+D` to end the Chat.

In a terminal, `wheatley chat` has these features:

- The Chat starts with a `WHEATLEY` banner. A terminal narrower than 52 columns gets a one-line banner.
- Type `/` to open the command menu under the prompt. Up and Down select a command, `Tab` completes it, and `Enter` runs it.
- `/help` lists the commands with their descriptions.
- The Up and Down arrows recall earlier input when the menu is closed. Wheatley saves the input history in `<home>/chat_history`.
- A spinner shows while a Run works, with the elapsed time. During a Tool call, it shows the Tool name. Between Tool calls, it rotates through short lines in Wheatley's voice. You can type the next message during the Run.
- `Ctrl+C` stops the active Run. On an empty prompt with no active Run, `Ctrl+C` ends the Chat.

If standard input or output is not a terminal, for example a pipe, `wheatley chat` reads and writes plain lines.

These commands work in a Chat:

| Command             | Action                                               |
| ------------------- | ---------------------------------------------------- |
| `/new`              | Start a new Conversation in this Chat.               |
| `/model <model-id>` | Use another model for this Conversation.             |
| `/compact`          | Compact the current Conversation.                    |
| `/stop`             | Stop the active Run in this Chat.                    |
| `/goal <objective>` | Start a long-running autonomous Run.                 |
| `/status`           | Show the Conversation, Run, model, and Agent health. |
| `/restart`          | Restart this Agent.                                  |
| `/exit`             | End the Chat.                                        |

If a Tool needs an Approval, the Chat shows the Tool name and its input. Answer with one of these values:

- `o`: allow this call once.
- `c`: allow this Tool for the rest of this Conversation.
- `a`: allow this Tool always. Wheatley adds an `allow` rule to the top of the `permissionPolicy` in `config.yaml`.
- `d <reason>`: deny this call. The Agent receives the reason.

## Dashboard

The daemon serves the dashboard on its TCP listener, by default <http://127.0.0.1:7420/>. The dashboard has these Deployment views:

- Overview
- Inbox
- Logs
- Secrets

Each Agent has these views:

- Chat
- Runs
- Memory
- Triggers and Extensions
- Config

The Control Server has no authentication. Keep the TCP listener on a loopback address. The server rejects browser connections from a foreign `Origin`. To allow another origin, add it to `daemon.allowedOrigins`.

## Triggers and webhooks

A Trigger starts a Run without an incoming message. A Trigger has one of three schedules:

- `cron`: a five-field cron expression in a time zone.
- `once`: one time at a given date or after a delay.
- `webhook`: an HTTP request to the Webhook Ingress.

To create a `cron` or `once` Trigger, use one of these methods:

- Open the Triggers and Extensions view in the dashboard and select **New Trigger**.
- Ask the Agent, for example "Remind me every weekday at 09:00 to check my email". The Agent uses the `schedule_trigger` Tool.

The Agent can also list and delete Triggers with `list_triggers` and `cancel_trigger`. An Agent cannot create or delete a `webhook` Trigger.

### Set up a webhook Trigger

1. Turn on the Webhook Ingress, as shown in [Webhooks](#webhooks).
2. Add a token to `secrets.yaml`, for example `MY_HOOK_TOKEN: <random value>`.
3. In the Triggers and Extensions view, create a Trigger with the **Webhook** schedule.
4. Set **Token secret** to `MY_HOOK_TOKEN`.
5. Ask the Agent to list its Triggers, and copy the `id` of the new Trigger.
6. Send a request:

   ```bash
   curl -X POST \
     -H "Authorization: Bearer <random value>" \
     --data 'Build 42 failed' \
     http://127.0.0.1:8788/webhooks/<agent>/<triggerId>
   ```

The Webhook Ingress answers `202 Accepted`. The Run appends the request body to the Trigger prompt. The limit for a request body is 256 KiB.

The dashboard does not show the Trigger ID or the webhook URL. The Runs view shows the Trigger ID only for Runs that a Trigger started.

## Memory

Each Agent keeps Memory in `agents/<name>/memory/`. The main file is `MEMORY.md`. The Agent reads `MEMORY.md` at the start of each new Conversation. The Agent writes Memory with the `memory_*` Tools.

`MEMORY.md` has a cap of 4,000 characters. To change the cap, set `memory.maxChars` on the Agent. By default, the Agent consolidates its Memory every day at 03:00. To turn this off, set `memory.consolidation.enabled: false`. You can also read Memory in the Memory view of the dashboard.

## Operations

### Run as a service

`wheatley service` manages a background service. It uses `systemd --user` on Linux and `launchd` on macOS.

```bash
wheatley service install
wheatley service start
wheatley service stop
wheatley service restart
wheatley service status
```

### Update

`wheatley update` updates an npm or pnpm install of `@wheatley-ai/cli` within its major version:

```bash
wheatley update --check
wheatley update
wheatley update --manager pnpm
```

`wheatley update` does not install a new major version. It prints the install command for that version instead. To install the latest release of any version, run `npm install --global @wheatley-ai/cli@latest`.

`wheatley update` refuses to run in a source checkout. Use `git` there. In Docker, `wheatley update` prints the Docker Compose commands.

After an update, restart the daemon, for example with `wheatley service restart`.

### Restore an Agent database

Wheatley backs up `agents/<name>/agent.sqlite` before a database migration and before a restore. Each Agent keeps its five newest backups in `agents/<name>/backups/`.

1. List the backups of an Agent:

   ```bash
   wheatley restore <agent>
   ```

2. Stop the daemon. `wheatley restore` refuses to run while the daemon runs.
3. Restore one backup:

   ```bash
   wheatley restore <agent> <backup>
   ```

## Write a Plugin

A Plugin adds Tools and Frontends to an Agent. The SDK package `@wheatley-ai/sdk` contains the Plugin contract and its types.

1. Create an ESM package for the Plugin and install the SDK:

   ```bash
   npm install @wheatley-ai/sdk
   ```

2. Default-export the Plugin from the package entry point:

   ```ts
   import { definePlugin } from "@wheatley-ai/sdk";

   export default definePlugin({
     apiVersion: 1,
     name: "hello",
     version: "1.0.0",
     setup: () => ({
       tools: [
         {
           name: "greet",
           description: "Greets the user",
           inputSchema: { type: "object", properties: {} },
           execute: async () => ({
             content: [{ type: "text", text: "Hello" }],
           }),
         },
       ],
     }),
   });
   ```

3. Install the Plugin package in the `extensions` folder of the Deployment home:

   ```bash
   npm install --prefix ~/.wheatley/extensions <plugin package>
   ```

4. Add the Plugin to the Agent in `config.yaml`, and restart the Agent:

   ```yaml
   agents:
     default:
       plugins:
         - source: <plugin package>
   ```

`source` can also be a file path. A path that starts with `./` or `../` resolves against the Deployment home. A path that starts with `~/` resolves against your home directory.

The Agent sees each Plugin Tool as `<plugin>:<tool>`, for example `hello:greet`. A Plugin Tool uses the `ask` action by default. Wheatley skips a Plugin with another `apiVersion`.

## Development

Run these commands from the repository root:

| Command          | Action                                       |
| ---------------- | -------------------------------------------- |
| `pnpm build`     | Build every package and the dashboard.       |
| `pnpm check`     | Run the Oxlint and `oxfmt` checks.           |
| `pnpm fix`       | Apply automatic Oxlint and `oxfmt` fixes.    |
| `pnpm typecheck` | Check the TypeScript types of every package. |
| `pnpm test`      | Run the Vitest test suite.                   |

If your shell uses an older Node.js version, run `eval "$(fnm env)" && fnm use` first.

### Release process

The `Release` workflow in `.github/workflows/release.yml` uses [release-please](https://github.com/googleapis/release-please). It runs on each push to `main`.

1. Write each commit title as a Conventional Commit, for example `feat: add a Trigger view` or `fix: close the socket`. release-please reads these titles to choose the next version and write `CHANGELOG.md`.
2. release-please opens or updates a release pull request. The pull request changes the version in the root `package.json`, `packages/wheatley/package.json`, and `packages/sdk/package.json`.
3. Merge the release pull request.
4. The workflow creates the `v<version>` tag and the GitHub release.
5. The workflow publishes `@wheatley-ai/sdk` and `@wheatley-ai/cli` to npm.
6. The workflow pushes the `linux/amd64` and `linux/arm64` image to `ghcr.io/sphericalkat/wheatley`.

Before version `1.0.0`, a `feat` commit raises the minor version, and a `fix` commit raises the patch version.

The workflow publishes to npm with [trusted publishing](https://docs.npmjs.com/trusted-publishers). It uses no npm token. Each npm package must have a trusted publisher with these values:

| Field                | Value          |
| -------------------- | -------------- |
| Organization or user | `SphericalKat` |
| Repository           | `wheatley`     |
| Workflow filename    | `release.yml`  |
| Environment          | (empty)        |

The repository must have **Settings > Actions > General > Allow GitHub Actions to create and approve pull requests** turned on.

## Known limitations

- A Unix socket path has a length limit of about 100 bytes. If the home path is too long, the daemon fails with `listen EINVAL` on `daemon.sock`. Keep the home path short.
- The dashboard does not show the Trigger ID or the webhook URL of a Trigger.
- Webhooks support only static Bearer tokens. HMAC signatures are not supported.
- The Control Server has no authentication.

## License

ISC
