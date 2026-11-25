import { homedir } from "node:os";
import path from "node:path";

import { AgentNameSchema, decode } from "@wheatley/protocol";

/** The Agent storage file that Wheatley migrations change. */
export const AGENT_DATABASE_FILE = "agent.sqlite";

/** The folder inside an Agent folder that holds the `VACUUM INTO` backups of `agent.sqlite`. */
export const BACKUPS_DIR = "backups";

/** The environment variable that overrides the Deployment home, for example `/data` in Docker. */
export const HOME_ENV = "WHEATLEY_HOME";

/** The environment variable that the Docker image sets to `1`. */
export const DOCKER_ENV = "WHEATLEY_DOCKER";

/** Returns the Deployment home: `$WHEATLEY_HOME` if set, else `~/.wheatley`. */
export const resolveHomeDir = (
  env: NodeJS.ProcessEnv = process.env,
  userHome: string = homedir()
): string => {
  const override = env[HOME_ENV];

  return override === undefined || override === ""
    ? path.join(userHome, ".wheatley")
    : path.resolve(override);
};

/**
 * Returns `<home>/agents/<agent>`.
 *
 * Errors: throws if `agent` is not a valid Agent name, so a name cannot escape the `agents` folder.
 */
export const agentDirFor = (homeDir: string, agent: string): string => {
  if (!decode(AgentNameSchema, agent).ok) {
    throw new Error(`Invalid Agent name: ${agent}`);
  }

  return path.join(homeDir, "agents", agent);
};
