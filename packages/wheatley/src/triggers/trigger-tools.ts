import { parseDuration, TRIGGER_NAME_MAX_LENGTH } from "@wheatley/protocol";
import type {
  ExtensionStatus,
  JsonValue,
  PermissionAction,
  Trigger,
  TriggerSchedule,
} from "@wheatley/protocol";
import type { JsonSchema, ToolContext, ToolResult } from "@wheatley/sdk";
import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

import type {
  ToolDescriptor,
  ToolProvider,
} from "../contracts/extension-catalog.js";
import type { Clock } from "../contracts/module.js";
import { canonicalToolName } from "../contracts/tool-names.js";
import type { TriggerRuntime } from "../contracts/trigger-runtime.js";
import { errorText } from "./errors.js";

const ChatTargetSchema = Type.Object(
  {
    bindingId: Type.String({ minLength: 1 }),
    chatId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);

const ScheduleInputSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("cron"),
      schedule: Type.String({
        description:
          "A 5-field cron expression: minute hour day-of-month month day-of-week, for example `0 8 * * 1-5`.",
        minLength: 1,
      }),
      timezone: Type.String({
        description: "An IANA time zone, for example `Europe/Berlin`.",
        minLength: 1,
      }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      at: Type.String({
        description:
          "An ISO 8601 date and time with an offset, for example `2026-12-01T09:00:00+01:00`.",
        pattern: String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$`,
      }),
      kind: Type.Literal("once"),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      delay: Type.String({
        description:
          "A delay from now, for example `90s`, `15m`, `2h`, or `1d`.",
        pattern: "^[0-9]+(ms|s|m|h|d)$",
      }),
      kind: Type.Literal("once"),
    },
    { additionalProperties: false }
  ),
]);

const ScheduleTriggerInputSchema = Type.Object(
  {
    conversationMode: Type.Optional(
      Type.Union([Type.Literal("per_firing"), Type.Literal("shared")], {
        description:
          "`per_firing` (default) starts a new Conversation for each firing. `shared` keeps one Conversation.",
      })
    ),
    name: Type.String({ maxLength: TRIGGER_NAME_MAX_LENGTH, minLength: 1 }),
    prompt: Type.String({
      description: "The instruction that each firing runs.",
      minLength: 1,
    }),
    schedule: ScheduleInputSchema,
    target: Type.Optional(
      Type.Object(ChatTargetSchema.properties, {
        additionalProperties: false,
        description:
          "The Chat that receives the result. The default is the current Chat.",
      })
    ),
  },
  { additionalProperties: false }
);

const EmptyInputSchema = Type.Object({}, { additionalProperties: false });

const CancelTriggerInputSchema = Type.Object(
  { triggerId: Type.String({ minLength: 1 }) },
  { additionalProperties: false }
);

/** What the Trigger Tools use. */
export interface TriggerToolDeps {
  readonly runtime: Pick<TriggerRuntime, "create" | "delete" | "list">;
  /** Marks a Trigger Run so that its final reply is not delivered. Resolves `false` if no Trigger started the Run. */
  readonly suppressDelivery: (runId: string) => Promise<boolean>;
  readonly clock: Clock;
}

interface TriggerTool<Schema extends TSchema> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Schema;
  readonly defaultAction: PermissionAction;
  readonly execute: (
    input: Static<Schema>,
    ctx: ToolContext,
    deps: TriggerToolDeps
  ) => Promise<ToolResult>;
}

/** The Trigger Tools hold no resources, so `close` resolves at once. */
const NOTHING_TO_CLOSE: Promise<void> = Promise.resolve();

const textResult = (text: string): ToolResult => ({
  content: [{ text, type: "text" }],
});

const errorResult = (text: string): ToolResult => ({
  content: [{ text, type: "text" }],
  isError: true,
});

const jsonResult = (value: JsonValue): ToolResult =>
  textResult(JSON.stringify(value, null, 2));

const summary = (trigger: Trigger): JsonValue => ({
  conversationMode: trigger.conversationMode,
  createdBy: trigger.createdBy,
  id: trigger.id,
  lastFiredAt: trigger.lastFiredAt,
  name: trigger.name,
  nextFireAt: trigger.nextFireAt,
  paused: trigger.paused,
  prompt: trigger.prompt,
  schedule: trigger.schedule,
  target: trigger.target,
});

type ScheduleInput = Static<typeof ScheduleInputSchema>;

/** Converts Tool schedule input into a stored schedule. Throws a `RangeError` for an unreadable time. */
const toSchedule = (input: ScheduleInput, now: number): TriggerSchedule => {
  if (input.kind === "cron") {
    return input;
  }

  const at =
    "at" in input ? Date.parse(input.at) : now + parseDuration(input.delay);

  if (Number.isNaN(at)) {
    throw new RangeError(
      `Invalid time: ${"at" in input ? input.at : input.delay}`
    );
  }

  return { at: new Date(at).toISOString(), kind: "once" };
};

const defineTriggerTool = <Schema extends TSchema>(
  tool: TriggerTool<Schema>
): TriggerTool<Schema> => tool;

const scheduleTrigger = defineTriggerTool({
  defaultAction: "allow",
  description:
    "Schedule a reminder or recurring task. A `cron` schedule repeats in a time zone. A `once` schedule fires one " +
    "time at `at` or after `delay`. The result goes to the current Chat unless you set `target`.",
  execute: async (input, ctx, { clock, runtime }) => {
    const target = input.target ?? ctx.chat;

    if (target === null) {
      return errorResult(
        "This Run has no Chat. Set `target` to the Chat that receives the result."
      );
    }

    const trigger = await runtime.create(
      {
        conversationMode: input.conversationMode ?? "per_firing",
        name: input.name,
        prompt: input.prompt,
        schedule: toSchedule(input.schedule, clock.now()),
        target,
      },
      "agent"
    );

    return jsonResult(summary(trigger));
  },
  inputSchema: ScheduleTriggerInputSchema,
  name: "schedule_trigger",
});

const listTriggers = defineTriggerTool({
  defaultAction: "allow",
  description:
    "List every Trigger of this Agent with its schedule, next fire time, and target Chat.",
  execute: async (_input, _ctx, { runtime }) => {
    const triggers = await runtime.list();

    return jsonResult(triggers.map(summary));
  },
  inputSchema: EmptyInputSchema,
  name: "list_triggers",
});

const cancelTrigger = defineTriggerTool({
  defaultAction: "allow",
  description:
    "Delete a `cron` or `once` Trigger by ID. Only the Operator can delete `webhook` Triggers.",
  execute: async (input, _ctx, { runtime }) => {
    const deleted = await runtime.delete(input.triggerId, "agent");

    return deleted
      ? textResult(`Deleted Trigger ${input.triggerId}.`)
      : errorResult(`No Trigger has the ID ${input.triggerId}.`);
  },
  inputSchema: CancelTriggerInputSchema,
  name: "cancel_trigger",
});

const suppressDelivery = defineTriggerTool({
  defaultAction: "allow",
  description:
    "In a Run that a Trigger started, do not send the final reply to the target Chat, for example when a check " +
    "found nothing to report.",
  execute: async (_input, ctx, deps) => {
    const suppressed = await deps.suppressDelivery(ctx.runId);

    return suppressed
      ? textResult("The final reply of this Run will not be delivered.")
      : errorResult(
          "suppress_delivery works only in a Run that a Trigger started."
        );
  },
  inputSchema: EmptyInputSchema,
  name: "suppress_delivery",
});

/** A Trigger Tool with its schema type erased, so that one list holds every Tool. */
interface BoundTool {
  readonly descriptor: ToolDescriptor;
  readonly run: (input: JsonValue, ctx: ToolContext) => Promise<ToolResult>;
}

const isJsonSchema = (value: unknown): value is JsonSchema =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Copies a TypeBox schema into plain JSON Schema for the model provider. */
const plainSchema = (schema: TSchema): JsonSchema => {
  const plain: unknown = structuredClone(schema);

  if (!isJsonSchema(plain)) {
    throw new TypeError("A Tool schema is not a JSON object");
  }

  return plain;
};

/** Binds a Tool to its dependencies. `run` checks the input against the Tool's schema first. */
const bind = <Schema extends TSchema>(
  tool: TriggerTool<Schema>,
  deps: TriggerToolDeps
): BoundTool => ({
  descriptor: {
    defaultAction: tool.defaultAction,
    description: tool.description,
    inputSchema: plainSchema(tool.inputSchema),
    name: canonicalToolName({ kind: "builtin" }, tool.name),
    source: "builtin",
  },
  run: async (input, ctx) => {
    if (!Value.Check(tool.inputSchema, input)) {
      const issues = Value.Errors(tool.inputSchema, input)
        .map((error) => `${error.instancePath || "/"} ${error.message}`)
        .join("; ");

      return errorResult(`Invalid input for ${tool.name}: ${issues}`);
    }

    return await tool.execute(input, ctx, deps);
  },
});

/**
 * Creates the `ToolProvider` of the built-in Trigger Tools: `schedule_trigger`, `list_triggers`, `cancel_trigger`, and
 * `suppress_delivery` (ADR 0010). The Permission Policy governs every call. Agents cannot create, change, or delete
 * `webhook` Triggers through these Tools.
 */
export const createTriggerToolProvider = (
  deps: TriggerToolDeps
): ToolProvider => {
  const tools = new Map(
    [
      bind(scheduleTrigger, deps),
      bind(listTriggers, deps),
      bind(cancelTrigger, deps),
      bind(suppressDelivery, deps),
    ].map((tool) => [tool.descriptor.name, tool])
  );

  const descriptors = [...tools.values()].map((tool) => tool.descriptor);

  return {
    close: async () => {
      await NOTHING_TO_CLOSE;
    },
    execute: async (name, input, ctx) => {
      const tool = tools.get(name);

      if (tool === undefined) {
        return errorResult(`Unknown Tool: ${name}`);
      }

      if (ctx.signal.aborted) {
        return errorResult(`${name} was aborted`);
      }

      try {
        return await tool.run(input, ctx);
      } catch (error) {
        return errorResult(errorText(error));
      }
    },
    health: (): readonly ExtensionStatus[] => [],
    tools: () => descriptors,
  };
};
