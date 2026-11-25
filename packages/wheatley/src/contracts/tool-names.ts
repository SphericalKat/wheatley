const TOOL_PART = /^[a-z][a-z0-9_]*$/u;

/** The MCP Tool name character set, which allows names such as `resolve-library-id`, `getIssue`, and `browser.navigate`. */
const MCP_TOOL_PART = /^[A-Za-z0-9_.-]{1,128}$/u;
const OWNER_PART = /^[a-z0-9][a-z0-9_-]*$/u;
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/gu;
const ESCAPED_WILDCARD = /\\\*/gu;

/** The Plugin name that Wheatley reserves for MCP Tool names. */
export const RESERVED_PLUGIN_NAME = "mcp";

/** Where a Tool comes from, with the owner name that its canonical name includes. */
export type ToolOrigin =
  | { readonly kind: "builtin" }
  | { readonly kind: "plugin"; readonly plugin: string }
  | { readonly kind: "mcp"; readonly server: string };

/**
 * Builds the canonical Tool name (ADR 0006): `<tool>` for built-ins, `<plugin>:<tool>` for Plugins, and
 * `mcp:<server>:<tool>` for MCP Servers. The Permission Policy matches these names.
 *
 * Built-in and Plugin Tool names match `^[a-z][a-z0-9_]*$`. MCP Tool names keep the name that the server reports and
 * match `^[A-Za-z0-9_.-]{1,128}$`. Throws a `RangeError` if a part breaks its pattern, or for a Plugin named `mcp`.
 */
export const canonicalToolName = (origin: ToolOrigin, tool: string): string => {
  const toolPattern = origin.kind === "mcp" ? MCP_TOOL_PART : TOOL_PART;

  if (!toolPattern.test(tool)) {
    throw new RangeError(`Invalid Tool name: ${tool}`);
  }

  if (origin.kind === "builtin") {
    return tool;
  }

  const owner = origin.kind === "plugin" ? origin.plugin : origin.server;

  if (
    !OWNER_PART.test(owner) ||
    (origin.kind === "plugin" && owner === RESERVED_PLUGIN_NAME)
  ) {
    throw new RangeError(`Invalid ${origin.kind} name: ${owner}`);
  }

  return origin.kind === "plugin"
    ? `${owner}:${tool}`
    : `${RESERVED_PLUGIN_NAME}:${owner}:${tool}`;
};

/**
 * Returns true if a canonical Tool name matches a Permission Policy pattern. `*` matches any run of characters,
 * including `:`; every other character matches itself, case-sensitively. For example `notes:*` matches `notes:add`, and `mcp:github:*`
 * matches every Tool of the `github` MCP Server.
 */
export const matchesToolPattern = (
  pattern: string,
  toolName: string
): boolean => {
  const source = pattern
    .replaceAll(REGEX_SPECIAL, String.raw`\$&`)
    .replaceAll(ESCAPED_WILDCARD, ".*");

  return new RegExp(`^${source}$`, "u").test(toolName);
};
