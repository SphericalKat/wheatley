# Wheatley

Wheatley is a self-hosted, always-on personal assistant that hosts one or more isolated agents in one deployment.

## Language

**Deployment**: One installed, running instance of Wheatley that hosts one or more **Agents**. _Avoid_: Instance, server, tenant

**Operator**: Whoever controls the host that runs the **Deployment**. The **Operator** manages every **Agent** through the admin CLI and the dashboard. Wheatley does not identify the **Operator**. _Avoid_: Admin, owner, root user

**Agent**: A named assistant inside a **Deployment** with its own settings, state, and **Conversations**, isolated from every other **Agent**. _Avoid_: Bot, assistant, persona

**Sender**: The person who sent a message to an **Agent**, named by the frontend display name for attribution only. A **Sender** has no account, permissions, or identity in Wheatley. _Avoid_: User, principal, member, account

**Permission Policy**: The rules of one **Agent** that set each tool to allow, ask, or deny. Every **Sender** of that **Agent** gets the same **Permission Policy**. _Avoid_: ACL, role, scope

**Approval**: A decision by a **Sender** in the originating **Chat**, or by the **Operator**, to let or stop one tool call that the **Permission Policy** sets to ask. _Avoid_: Confirmation, consent

**Frontend**: A kind of chat surface through which a **Sender** talks to an **Agent**, for example Telegram, Slack, or the CLI. _Avoid_: Channel, client, interface

**Frontend Binding**: One configured **Frontend** endpoint, for example one Telegram bot token, connected to exactly one **Agent**. An **Agent** can have many **Frontend Bindings**. _Avoid_: Integration, connector, route

**Chat**: One place on a **Frontend** where messages arrive, for example a Telegram DM, a Telegram group, or a Slack thread. Each **Chat** has one current **Conversation**. _Avoid_: Room, channel

**Conversation**: One transcript and context inside an **Agent**. A **Conversation** belongs to one **Chat**, where every **Sender** shares it, or to one **Trigger**. _Avoid_: Session, thread

**Run**: One unit of **Agent** work inside one **Conversation**, from a message or a **Trigger** firing until the **Agent** is idle again. _Avoid_: Job, turn, execution

**Trigger**: A rule that starts a **Run** without an incoming message, for example a schedule or a webhook. Each **Trigger** belongs to one **Agent**, names one target **Chat**, and either keeps one **Conversation** across firings or starts a new one for each firing. _Avoid_: Cron, job, automation

**Plugin**: An extension configured on an **Agent** that provides **Tools** or **Frontends**. _Avoid_: Addon, mod, module

**Tool**: One callable action that an **Agent** runs during a **Run**, provided by Wheatley, a **Plugin**, or an **MCP Server**, and governed by the **Permission Policy**. _Avoid_: Action, function, command

**MCP Server**: An external tool provider connected to one **Agent** over the Model Context Protocol. _Avoid_: Integration, connector, tool host

**Skill**: A folder of Markdown instructions and optional files that an **Agent** loads on demand during a **Run**. _Avoid_: Prompt template, playbook, workflow
