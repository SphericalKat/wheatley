import type { JsonObject } from "@wheatley-ai/sdk";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import {
  assertOk,
  MAX_PROVIDER_RESPONSE_BYTES,
  PROVIDER_TIMEOUT_MS,
  readTextWithin,
  withTimeout,
} from "./http.js";

const SSE_DATA_PREFIX = "data: ";

const MCP_ACCEPT = "application/json, text/event-stream";

/** The `result` of an MCP `tools/call` response. Only `text` blocks carry `text`. */
const ToolCallResult = Type.Object({
  content: Type.Array(
    Type.Object({ text: Type.Optional(Type.String()), type: Type.String() })
  ),
  structuredContent: Type.Optional(Type.Unknown()),
});

/** The reduced `result` of an MCP `tools/call` response. */
export type McpToolResult = Static<typeof ToolCallResult>;

const Envelope = Type.Object({
  error: Type.Optional(Type.Object({ message: Type.String() })),
  result: Type.Optional(Type.Unknown()),
});

/** One HTTP POST to an MCP endpoint. */
export interface McpPost {
  readonly url: string;
  /** The name of the request in error messages. */
  readonly label: string;
  readonly body: JsonObject;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

/** Sends one JSON-RPC message to an MCP Streamable HTTP endpoint, with the provider time limit. */
export const postMcp = async (post: McpPost): Promise<Response> => {
  const response = await fetch(post.url, {
    body: JSON.stringify(post.body),
    headers: {
      ...post.headers,
      accept: MCP_ACCEPT,
      "content-type": "application/json",
    },
    method: "POST",
    signal: withTimeout(post.signal, PROVIDER_TIMEOUT_MS),
  });

  await assertOk(post.label, response);

  return response;
};

/** Reads the first JSON-RPC envelope of a body that is either one JSON object or a stream of SSE `data:` lines. */
const parseEnvelope = (body: string): Static<typeof Envelope> | undefined => {
  const candidates = [
    body.trim(),
    ...body
      .split("\n")
      .filter((line) => line.startsWith(SSE_DATA_PREFIX))
      .map((line) => line.slice(SSE_DATA_PREFIX.length).trim()),
  ];

  for (const candidate of candidates) {
    if (!candidate.startsWith("{")) {
      continue;
    }

    const parsed: unknown = JSON.parse(candidate);

    if (Value.Check(Envelope, parsed)) {
      return parsed;
    }
  }

  return undefined;
};

/** One MCP `tools/call` request. */
export interface McpToolCall {
  readonly url: string;
  readonly tool: string;
  readonly arguments: JsonObject;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

/**
 * Calls one Tool of a remote MCP server without a session handshake.
 *
 * Returns `undefined` if the response holds no `tools/call` result.
 *
 * Errors: rejects with `HttpStatusError` for a non-2xx status, and with an `Error` for a JSON-RPC error, a body larger
 * than `MAX_PROVIDER_RESPONSE_BYTES`, or a time-out.
 */
export const callMcpTool = async (
  call: McpToolCall
): Promise<McpToolResult | undefined> => {
  const response = await postMcp({
    body: {
      id: 1,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: call.arguments, name: call.tool },
    },
    headers: call.headers,
    label: call.tool,
    signal: call.signal,
    url: call.url,
  });

  const body = await readTextWithin(
    response,
    MAX_PROVIDER_RESPONSE_BYTES,
    () =>
      new Error(
        `${call.tool} response exceeded ${MAX_PROVIDER_RESPONSE_BYTES} bytes`
      )
  );

  const envelope = parseEnvelope(body);

  if (envelope?.error !== undefined) {
    throw new Error(`${call.tool} failed: ${envelope.error.message}`);
  }

  const result = envelope?.result;

  return Value.Check(ToolCallResult, result) ? result : undefined;
};

/** Returns the first non-empty text block of an MCP Tool result. */
export const firstText = (
  result: McpToolResult | undefined
): string | undefined =>
  result?.content.find(
    ({ text, type }) => type === "text" && text !== undefined && text !== ""
  )?.text;
