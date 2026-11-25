// A Plugin for the extensions flow. `add` appends a note to the Plugin data folder. `wipe` marks the folder as wiped.
import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { decode } from "@wheatley-ai/protocol";
import { definePlugin } from "@wheatley-ai/sdk";
import type { JsonSchema, JsonValue, ToolResult } from "@wheatley-ai/sdk";
import { Type } from "typebox";
import type { TSchema } from "typebox";

const ConfigSchema = Type.Object(
  { prefix: Type.String() },
  { additionalProperties: false }
);

const AddInputSchema = Type.Object(
  { text: Type.String() },
  { additionalProperties: false }
);

// Wheatley validates with these plain JSON Schemas. The TypeBox schemas above give `execute` typed values.
const configJsonSchema: JsonSchema = {
  additionalProperties: false,
  properties: { prefix: { type: "string" } },
  required: ["prefix"],
  type: "object",
};

const addInputJsonSchema: JsonSchema = {
  additionalProperties: false,
  properties: { text: { type: "string" } },
  required: ["text"],
  type: "object",
};

const emptyJsonSchema: JsonSchema = { properties: {}, type: "object" };

const text = (value: string): ToolResult => ({
  content: [{ text: value, type: "text" }],
});

/** Decodes a value that Wheatley validated against the same schema. */
const decoded = <Schema extends TSchema>(schema: Schema, value: JsonValue) => {
  const result = decode(schema, value);

  if (!result.ok) {
    throw new Error("Wheatley passed a value that breaks its schema");
  }

  return result.value;
};

export default definePlugin({
  apiVersion: 1,
  configSchema: configJsonSchema,
  name: "notes",
  setup: (ctx) => {
    const { prefix } = decoded(ConfigSchema, ctx.config);

    return {
      tools: [
        {
          description: "Adds a note",
          execute: async (input: JsonValue) => {
            const { text: note } = decoded(AddInputSchema, input);

            await appendFile(path.join(ctx.dataDir, "notes.txt"), `${note}\n`);

            return text(`${prefix}${note}`);
          },
          inputSchema: addInputJsonSchema,
          name: "add",
        },
        {
          description: "Deletes every note",
          execute: async () => {
            await writeFile(path.join(ctx.dataDir, "wiped"), "yes");

            return text("wiped");
          },
          inputSchema: emptyJsonSchema,
          name: "wipe",
        },
      ],
    };
  },
  version: "1.0.0",
});
