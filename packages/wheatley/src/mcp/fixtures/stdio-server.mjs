// A mock MCP Server for the stdio contract tests. The tests run it with `node` as a child process.
import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

const textSchema = fromJsonSchema({
  additionalProperties: false,
  properties: { text: { type: "string" } },
  required: ["text"],
  type: "object",
});

const emptySchema = fromJsonSchema({ properties: {}, type: "object" });

const createServer = () => {
  const server = new McpServer({ name: "fixture-stdio", version: "1.0.0" });

  server.registerTool(
    "echo",
    { description: "Returns the text", inputSchema: textSchema },
    /** @param {{ text: string }} input The validated Tool input. */
    ({ text }) => ({ content: [{ text, type: "text" }] })
  );

  server.registerTool(
    "read-token",
    {
      description: "Returns the FIXTURE_TOKEN environment variable",
      inputSchema: emptySchema,
    },
    () => ({
      content: [{ text: process.env.FIXTURE_TOKEN ?? "", type: "text" }],
    })
  );

  server.registerTool(
    "fail",
    { description: "Reports an error", inputSchema: emptySchema },
    () => ({ content: [{ text: "it broke", type: "text" }], isError: true })
  );

  server.registerTool(
    "pid",
    { description: "Returns the server process ID", inputSchema: emptySchema },
    () => ({ content: [{ text: String(process.pid), type: "text" }] })
  );

  server.registerTool(
    "crash",
    { description: "Ends the server process", inputSchema: emptySchema },
    () => {
      process.exit(1);
    }
  );

  return server;
};

serveStdio(createServer);
