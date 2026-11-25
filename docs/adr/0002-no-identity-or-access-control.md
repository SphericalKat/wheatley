# No identity or access control in Wheatley

Wheatley keeps no user accounts, principals, or access-control lists. The **Agent** is the tenant: anyone who can reach a **Frontend Binding** of an **Agent** shares that **Agent**, its settings, and its **Permission Policy**. The **Operator** is whoever controls the host, and the admin CLI and dashboard rely on host protections (a local Unix socket, a localhost-only listener, and the **Operator**'s own proxy or VPN for remote access). Identity management would add complex requirements to a single-household, self-hosted assistant, and frontends already control who can reach them.

## Consequences

- To keep two groups of people apart, the **Operator** creates two **Agents** with separate **Frontend Bindings**.
- A **Frontend Binding** connects to exactly one **Agent**, so one endpoint never exposes a second **Agent**.
- A **Sender** display name is stored for attribution only and never used for authorization.
- Any **Sender** in the originating **Chat** can give an **Approval**.

## Considered Options

- A Deployment-wide principal with linked frontend identities and per-agent grants: rejected as the identity management this decision avoids.
- A shared admin token for the dashboard: rejected, because Wheatley would then store and rotate a credential that host protections already replace.
