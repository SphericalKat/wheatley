import type {
  CallToolResult,
  ContentBlock,
} from "@modelcontextprotocol/client";
import { isJsonValue } from "@wheatley/protocol";
import type { JsonObject } from "@wheatley/protocol";
import type { ToolContent, ToolResult } from "@wheatley/sdk";

/** Returns true if `value` is a JSON object, not an array or `null`. */
export const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  isJsonValue(value);

/** A Tool result that reports `text` to the model as an error. */
export const errorResult = (text: string): ToolResult => ({
  content: [{ text, type: "text" }],
  isError: true,
});

const base64Bytes = (data: string): number => Buffer.byteLength(data, "base64");

/** Converts one MCP content block. `text` and `image` pass through, and every other block becomes `text`. */
const toToolContent = (block: ContentBlock): ToolContent => {
  switch (block.type) {
    case "text": {
      return { text: block.text, type: "text" };
    }

    case "image": {
      return { data: block.data, mimeType: block.mimeType, type: "image" };
    }

    case "audio": {
      return {
        text: `[audio ${block.mimeType}, ${base64Bytes(block.data)} bytes]`,
        type: "text",
      };
    }

    case "resource_link": {
      const mimeType =
        block.mimeType === undefined ? "" : ` (${block.mimeType})`;

      return {
        text: `[resource link ${block.name}: ${block.uri}${mimeType}]`,
        type: "text",
      };
    }

    case "resource": {
      const { resource } = block;

      if ("text" in resource) {
        return { text: resource.text, type: "text" };
      }

      const mimeType =
        resource.mimeType === undefined ? "" : ` ${resource.mimeType}`;

      return {
        text: `[resource ${resource.uri}${mimeType}, ${base64Bytes(resource.blob)} bytes]`,
        type: "text",
      };
    }

    default: {
      return { text: JSON.stringify(block), type: "text" };
    }
  }
};

/**
 * Converts an MCP `CallToolResult` into a Tool result for the model.
 *
 * `structuredContent` becomes a JSON `text` block only if `content` has no `text` block. The MCP specification asks
 * servers to repeat structured output as text, so this rule prevents a second copy.
 */
export const toToolResult = (result: CallToolResult): ToolResult => {
  const content = result.content.map((block) => toToolContent(block));
  const hasText = content.some((block) => block.type === "text");

  if (result.structuredContent !== undefined && !hasText) {
    content.push({
      text: JSON.stringify(result.structuredContent),
      type: "text",
    });
  }

  return result.isError === true ? { content, isError: true } : { content };
};
