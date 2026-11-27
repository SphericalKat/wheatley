import type { ToolResult } from "@wheatley-ai/sdk";

/** A Tool result with one text block. */
export const textResult = (text: string): ToolResult => ({
  content: [{ text, type: "text" }],
});

/** A Tool result that reports `text` to the model as an error. */
export const errorResult = (text: string): ToolResult => ({
  content: [{ text, type: "text" }],
  isError: true,
});
