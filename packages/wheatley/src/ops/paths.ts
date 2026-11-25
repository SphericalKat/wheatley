import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { AgentNameSchema, decode } from "@wheatley-ai/protocol";

/** The Agent storage file that Wheatley migrations change. */
export const AGENT_DATABASE_FILE = "agent.sqlite";

/** The folder inside an Agent folder that holds the `VACUUM INTO` backups of `agent.sqlite`. */
export const BACKUPS_DIR = "backups";

/** The environment variable that overrides the Wheatley home folder, for example `/data` in Docker. */
export const HOME_ENV = "WHEATLEY_HOME";

/** The environment variable that the Docker image sets to `1`. */
export const DOCKER_ENV = "WHEATLEY_DOCKER";

/** Returns the value of an environment variable, or `undefined` if it is unset or empty. */
export const envValue = (
  env: NodeJS.ProcessEnv,
  name: string
): string | undefined => {
  const value = env[name];

  return value === undefined || value === "" ? undefined : value;
};

/** Returns `true` inside the Wheatley Docker image. */
export const isDocker = (env: NodeJS.ProcessEnv): boolean =>
  env[DOCKER_ENV] === "1";

/**
 * Returns the Wheatley home folder: `$WHEATLEY_HOME` if set, else `~/.wheatley`. The CLI and the Deployment context
 * (`DeploymentModuleContext.homeDir`) must both use this value, so that they see the same Agent folders.
 */
export const resolveHomeDir = (
  env: NodeJS.ProcessEnv = process.env,
  userHome: string = homedir()
): string => {
  const override = envValue(env, HOME_ENV);

  return override === undefined
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

/** Returns `true` for a file system error with code `ENOENT`. */
export const isMissing = (error: Error): boolean =>
  "code" in error && error.code === "ENOENT";

/** Resolves `true` if `target` exists. Errors: rejects for an error other than `ENOENT`, for example `EACCES`. */
export const pathExists = async (target: string): Promise<boolean> => {
  try {
    await stat(target);

    return true;
  } catch (error) {
    if (error instanceof Error && isMissing(error)) {
      return false;
    }

    throw error;
  }
};
