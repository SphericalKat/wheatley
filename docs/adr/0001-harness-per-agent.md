# One pi-durable Harness and storage file per Agent

One **Deployment** hosts many **Agents** in one daemon process, and each **Agent** owns one `@earendil-works/pi-durable` Harness over its own SQLite file. A storage commit error (`SessionFailed`) closes the whole Harness, so a shared Harness would stop every **Agent** for one failure. Separate files also make backup, export, and deletion of an **Agent** a file operation. Deployment-wide state, such as the **Agent** list and **Frontend Bindings**, lives outside the **Agent** storage files.

## Considered Options

- One shared Harness for all **Agents**: rejected, because one storage error stops every **Agent** and isolation is only logical.
- One OS process per **Agent**: rejected for v1, because it needs a supervisor and IPC inside the **Deployment** for isolation that separate Harnesses already give.
