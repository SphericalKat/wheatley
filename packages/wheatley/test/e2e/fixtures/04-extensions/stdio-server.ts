// A stdio MCP Server for the extensions flow. The daemon starts it with `node` as a child process.
import { env } from "node:process";

import { fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

const createServer = (): McpServer => {
  const server = new McpServer({ name: "e2e-stdio", version: "1.0.0" });

  server.registerTool(
    "echo",
    {
      description: "Returns the text",
      inputSchema: fromJsonSchema<{ text: string }>({
        additionalProperties: false,
        properties: { text: { type: "string" } },
        required: ["text"],
        type: "object",
      }),
    },
    ({ text }) => ({ content: [{ text, type: "text" }] })
  );

  server.registerTool(
    "read-token",
    {
      description: "Returns the FIXTURE_TOKEN environment variable",
      inputSchema: fromJsonSchema({ properties: {}, type: "object" }),
    },
    () => ({ content: [{ text: env.FIXTURE_TOKEN ?? "", type: "text" }] })
  );

  return server;
};

serveStdio(createServer);
