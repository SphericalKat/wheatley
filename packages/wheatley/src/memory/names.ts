import path from "node:path";

import { SeamError } from "../contracts/errors.js";

/** The name of `MEMORY.md`. */
export const MEMORY_NAME = "MEMORY";

/** The folder of the Memory files inside the Agent folder. */
export const MEMORY_DIR_NAME = "memory";

const NAME = /^(?:MEMORY|[a-z0-9][a-z0-9-]{0,63})$/u;
const FILE_NAME = /^(?<name>MEMORY|[a-z0-9][a-z0-9-]{0,63})\.md$/u;

/** Returns true if `name` is `MEMORY` or a valid topic slug. */
export const isMemoryName = (name: string): boolean => NAME.test(name);

/** Throws `SeamError("invalid_name")` unless `name` is `MEMORY` or a valid topic slug. */
export const assertMemoryName = (name: string): void => {
  if (!isMemoryName(name)) {
    throw new SeamError(
      "invalid_name",
      `Invalid Memory name: ${name}. Use MEMORY or a slug that matches ^[a-z0-9][a-z0-9-]{0,63}$.`
    );
  }
};

/** Returns the Memory name of a file in the Memory folder, or `undefined` for any other file. */
export const memoryNameOfFile = (fileName: string): string | undefined =>
  FILE_NAME.exec(fileName)?.groups?.name;

/** Returns the Markdown file name for a valid Memory name, for example `MEMORY.md`. */
export const memoryFileName = (name: string): string => `${name}.md`;

/** Returns the path of the Markdown file for a valid Memory name. */
export const memoryFilePath = (dir: string, name: string): string =>
  path.join(dir, memoryFileName(name));
