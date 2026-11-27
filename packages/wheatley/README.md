# @wheatley-ai/cli

Wheatley is a personal AI assistant that you host yourself. It runs as a daemon on your machine or server and keeps working when you close the terminal. It remembers what you tell it and runs jobs on a schedule. Before it writes a file or runs a shell command, it asks you.

You can talk to it from the terminal, from the web dashboard, or from Telegram, Slack, and Discord.

This package installs the `wheatley` command. The daemon, the CLI, and the dashboard all ship in it.

## Install

You need Node.js 26.13.1 or newer.

```sh
npm install -g @wheatley-ai/cli
```

pnpm works too: `pnpm add -g @wheatley-ai/cli`.

## Quick start

Create the config files. By default they go in `~/.wheatley`. Set `WHEATLEY_HOME` or pass `--home` to put them somewhere else.

```sh
wheatley init
```

Put your API key in `~/.wheatley/secrets.yaml`:

```yaml
ANTHROPIC_API_KEY: sk-ant-...
```

Start the daemon:

```sh
wheatley daemon
```

Then, in another terminal:

```sh
wheatley ask "Summarize the README in the current folder"
wheatley chat
```

The dashboard is at <http://127.0.0.1:7420>.

`wheatley init` sets up Anthropic with `claude-sonnet-5-5`. For another provider, pass `--provider` and `--model`. For example, `wheatley init --provider openai --model gpt-5.4-mini` expects `OPENAI_API_KEY`.

## Run it in the background

`wheatley service` installs a user service: systemd on Linux, launchd on macOS.

```sh
wheatley service install
wheatley service start
wheatley service status
```

## Commands

| Command | What it does |
| --- | --- |
| `wheatley init` | Create `config.yaml` and `secrets.yaml` |
| `wheatley daemon` | Run the daemon in the foreground |
| `wheatley chat` | Open an interactive chat with an agent |
| `wheatley ask "<prompt>"` | Send one prompt and print the reply |
| `wheatley status` | Show the health of the daemon and each agent |
| `wheatley service <action>` | `install`, `start`, `stop`, `restart`, or `status` |
| `wheatley update` | Update to the newest release in your major version |
| `wheatley restore <agent> [id]` | List or restore an agent's database backups |

Run `wheatley --help` for all the options.

With no arguments, `ask` reads the prompt from stdin:

```sh
{ echo "Review this diff:"; git diff; } | wheatley ask
```

If stdin is not a terminal, `ask` cannot ask for approval. It denies every tool call that needs one.

## Configuration

Wheatley reads its settings from `~/.wheatley/config.yaml`. Secrets go in `secrets.yaml`, and the config refers to them by name. If an environment variable has the same name as a secret, the variable wins.

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

    # First match wins. Tools without a rule use their own default.
    permissionPolicy:
      - tool: read_file
        action: allow
      - tool: shell
        action: ask

    # Chat with the agent from Telegram.
    frontends:
      - id: phone
        type: telegram
        config:
          botToken:
            secret: TELEGRAM_BOT_TOKEN
          allowedChatIds: [123456789]

    # Give the agent the tools of an MCP server.
    mcpServers:
      github:
        transport: http
        url: https://api.githubcopilot.com/mcp/
        headers:
          Authorization:
            secret: GITHUB_MCP_AUTH
```

You can define more than one agent. Each agent gets its own model, memory, schedule, and folder under `~/.wheatley/agents/<name>/`. After you edit the config, restart the agent from the dashboard or with `/restart` in a chat.

## Approvals

The file and shell tools work inside `agents/<name>/workspace`. Writing files, running shell commands, and calling MCP tools need your approval by default. When the agent wants to do one of these, the chat shows the tool and its input. You answer with one of these:

- `o`: allow it once.
- `c`: allow it for the rest of the conversation.
- `a`: allow it always. Wheatley adds an `allow` rule to your config.
- `d <reason>`: deny it, and tell the agent why.

An approval waits 15 minutes and then expires. Change this with `approvalTimeout` on the agent.

## Chat commands

| Command             | What it does                                   |
| ------------------- | ---------------------------------------------- |
| `/new`              | Start a new conversation                       |
| `/model <id>`       | Use another model for this conversation        |
| `/compact`          | Compact the conversation to save context       |
| `/stop`             | Stop the current run                           |
| `/goal <objective>` | Start a long-running task                      |
| `/status`           | Show the conversation, model, and agent health |
| `/restart`          | Restart the agent                              |

## What else it does

- **Memory.** Each agent keeps notes in `agents/<name>/memory/MEMORY.md` and reads them at the start of each conversation. Every day at 03:00, the agent reviews its notes. It merges duplicates and removes facts that are out of date.
- **Schedules.** Ask "remind me every weekday at 9 to check my email" and the agent creates a cron trigger. It can set one-off reminders too. A webhook trigger starts a run when it receives an HTTP request. You create webhook triggers in the dashboard.
- **Skills.** Put a folder with a `SKILL.md` in `~/.wheatley/skills/` to share it with all agents, or in `agents/<name>/skills/` for one agent.
- **Plugins.** Add your own tools and chat integrations in TypeScript. See [`@wheatley-ai/sdk`](https://www.npmjs.com/package/@wheatley-ai/sdk).

## Docker

If you would rather not install Node.js, use the image on the GitHub Container Registry:

```sh
docker volume create wheatley-data
docker run --rm -v wheatley-data:/data ghcr.io/sphericalkat/wheatley:latest wheatley init
docker run --rm -v wheatley-data:/data ghcr.io/sphericalkat/wheatley:latest \
  sh -c 'printf "daemon:\n  host: 0.0.0.0\n  port: 7420\n" >> /data/config.yaml'
docker run --rm -v wheatley-data:/data ghcr.io/sphericalkat/wheatley:latest \
  sh -c 'echo "ANTHROPIC_API_KEY: sk-ant-..." >> /data/secrets.yaml'

docker run -d --name wheatley --init --restart unless-stopped --stop-timeout 45 \
  -p 127.0.0.1:7420:7420 -v wheatley-data:/data ghcr.io/sphericalkat/wheatley:latest
```

Each release gets four image tags. For release `0.1.0`, these are `0.1.0`, `0.1`, `0`, and `latest`.

## Updating

```sh
wheatley update --check
wheatley update
```

`wheatley update` stays inside your current major version. It finds out how you installed Wheatley and uses the same tool: npm, pnpm, yarn, bun, Homebrew, or the `curl` installer. To override the detection, pass `--method npm|pnpm|yarn|bun|brew|curl`. For a Volta, mise, AUR, or Docker install, it prints the update instructions and changes nothing.

To move to a new major version, run `npm install -g @wheatley-ai/cli@latest`. Then restart the daemon, for example with `wheatley service restart`.

## Security

The daemon has no login. Anyone who can reach port 7420 can use your agents, so keep it on `127.0.0.1`, which is the default. It also rejects browser requests from other origins. If you need remote access, use an SSH tunnel or a private network such as Tailscale.

## License

ISC
