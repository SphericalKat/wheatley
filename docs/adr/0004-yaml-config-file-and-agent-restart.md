# One YAML config file, applied by restarting the changed Agent

The **Deployment** settings (the **Agents**, **Frontend Bindings**, **Permission Policies**, and enabled extensions) live in one `config.yaml` file. Secret values live in a separate owner-only `secrets.yaml`. The dashboard saves changes to these files through the Config Store, and it uses a YAML library that keeps comments. A change takes effect when the **Operator** restarts the changed **Agent** or **Frontend Binding**. The other **Agents** keep running. The **Operator** can then edit, diff, and back up settings as plain files.

## Considered Options

- Settings in SQLite: rejected, because the **Operator** cannot hand-edit or version the settings.
- A file that seeds a database at first start: rejected, because settings would then live in two places.
- Watch the file and apply changes at once: rejected, because a half-saved file could change a running **Agent**.
- Restart the whole daemon for every change: rejected, because it stops every **Agent** for an edit to one.
