import { mkdir } from "node:fs/promises";
import path from "node:path";

import { isJsonValue } from "@wheatley/protocol";
import type {
  AgentConfig,
  BindingStatus,
  ChatKey,
  FrontendBindingConfig,
} from "@wheatley/protocol";
import { BUILTIN_COMMANDS, DeliveryError } from "@wheatley/sdk";
import type {
  Attachment,
  Delivery,
  Frontend,
  FrontendBinding,
  FrontendContext,
  FrontendSink,
  RunEvent,
  SecretReader,
  WebhookRoute,
  WebhookRouteHandler,
} from "@wheatley/sdk";

import type { AgentModuleContext } from "../contracts/module.js";
import type { AgentHost, MountedModule } from "../core/agent/agent.js";
import { CLI_BINDING_ID } from "../core/config/validate.js";
import { errorMessage } from "../core/error-message.js";
import type { BusListener, EventBus } from "../core/events.js";
import { compileSchema } from "../plugins/schema.js";

/** The per-file attachment limit of every binding: 10 MiB (SDK `FrontendContext.maxAttachmentBytes`). */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** The folder inside the Agent folder that holds one data folder per Frontend Binding. */
export const FRONTENDS_DIR = "frontends";

/** The folder inside the Agent folder for staged attachments of every binding. */
export const STAGING_DIR = "staging";

/**
 * Mounts a Frontend webhook route on the Webhook Ingress at `/frontends/<agent>/<bindingId>/<pathSuffix>`. The returned
 * route unmounts it.
 *
 * Errors: throws `SeamError` `invalid_name` if `pathSuffix` is empty, contains `..`, or contains a character
 * outside `A-Z a-z 0-9 . _ ~ - /`. Throws `conflict` if the path is already mounted. The host passes no function if the Webhook Ingress is disabled.
 */
export type RegisterFrontendRoute = (
  agent: string,
  bindingId: string,
  pathSuffix: string,
  handler: WebhookRouteHandler
) => WebhookRoute;

/** Options of `createFrontendHost`. */
export interface FrontendHostOptions {
  readonly config: AgentConfig;
  readonly secrets: SecretReader;
  /** The Deployment event bus. The host forwards live Run progress of its Chats to the bindings. */
  readonly events: Pick<EventBus, "listen">;
  /** Absent if the Webhook Ingress is disabled. Bindings in webhook mode then fail to start. */
  readonly registerRoute?: RegisterFrontendRoute;
  readonly maxAttachmentBytes?: number;
}

/** One configured Frontend Binding and its state. */
interface HostedBinding {
  readonly config: FrontendBindingConfig;
  binding: FrontendBinding | undefined;
  status: BindingStatus;
  readonly routes: WebhookRoute[];
}

/** The Frontend Bindings of one Agent: the hosted module and the outbox delivery path. */
export interface FrontendHost {
  /** Creates bindings in `start`, so a broken binding only reports `failed` and the Agent keeps running. */
  readonly mount: (
    ctx: AgentModuleContext,
    host: AgentHost
  ) => Promise<MountedModule>;
  /**
   * Delivers outbox work through a running binding. Rejects with a permanent `DeliveryError` for an unknown binding,
   * and with a retryable one for a binding that is not running.
   */
  readonly deliver: (bindingId: string, delivery: Delivery) => Promise<void>;
}

const attachmentNote = (attachment: Attachment): string =>
  attachment.kind === "file"
    ? `[Attachment: ${attachment.filename} (${attachment.mimeType}, ${attachment.sizeBytes} bytes) at ${attachment.path}]`
    : `[Attachment: ${attachment.filename} (${attachment.mimeType}), not stored]`;

/** The Agent takes text only, so staged attachments reach the model as notes with their file paths. */
const inboundText = (
  text: string,
  attachments: readonly Attachment[] | undefined
): string =>
  [text, ...(attachments ?? []).map(attachmentNote)]
    .filter((part) => part !== "")
    .join("\n");

const failedStatus = (
  config: FrontendBindingConfig,
  error: string
): BindingStatus => ({
  error,
  id: config.id,
  state: "failed",
  type: config.type,
});

/** The Run ID of a Run event payload, or `undefined` for any other event. */
const runIdOf = (payload: Parameters<BusListener>[1]): string | undefined => {
  if ("runId" in payload) {
    return payload.runId;
  }

  return "run" in payload ? payload.run.runId : undefined;
};

/** Maps a Deployment event of a tracked Run to the binding's ephemeral `RunEvent`. */
const runEventOf = (
  name: Parameters<BusListener>[0],
  payload: Parameters<BusListener>[1],
  runId: string,
  chatId: string
): RunEvent | undefined => {
  if (name === "run.delta" && "delta" in payload) {
    return { chatId, delta: payload.delta, kind: "text_delta", runId };
  }

  if (name === "run.toolStarted" && "toolCallId" in payload) {
    return {
      chatId,
      kind: "tool_started",
      runId,
      toolCallId: payload.toolCallId,
      toolName: payload.toolName,
    };
  }

  if (
    name === "run.toolFinished" &&
    "toolCallId" in payload &&
    "isError" in payload
  ) {
    return {
      chatId,
      isError: payload.isError,
      kind: "tool_finished",
      runId,
      toolCallId: payload.toolCallId,
      toolName: payload.toolName,
    };
  }

  if (name === "run.finished" && "run" in payload) {
    const { status } = payload.run;

    return status === "completed" || status === "failed" || status === "stopped"
      ? { chatId, kind: "run_finished", runId, status }
      : undefined;
  }

  return undefined;
};

/**
 * Creates the Frontend Binding host of one Agent (ADR 0007, ADR 0012). For each enabled `frontends` entry, it validates
 * the config against the Frontend's `configSchema`, creates the binding with a `FrontendContext`, and starts it with a
 * sink that hands messages, commands, and Approval decisions to the Agent.
 */
export const createFrontendHost = (
  options: FrontendHostOptions
): FrontendHost => {
  const bindings = new Map<string, HostedBinding>(
    (options.config.frontends ?? [])
      .filter((config) => config.enabled !== false)
      .map((config) => [
        config.id,
        {
          binding: undefined,
          config,
          routes: [],
          status: { id: config.id, state: "starting", type: config.type },
        },
      ])
  );

  /** Run ID to the Chat of a Run that started from a binding of this Agent. */
  const runChats = new Map<string, ChatKey>();
  let stopped = false;

  const deliver = async (
    bindingId: string,
    delivery: Delivery
  ): Promise<void> => {
    // The CLI and the dashboard read Approvals and replies from live events, so CLI deliveries need no transport.
    if (bindingId === CLI_BINDING_ID) {
      return;
    }

    const hosted = bindings.get(bindingId);

    if (hosted === undefined) {
      throw new DeliveryError(`Unknown Frontend Binding: ${bindingId}`, {
        kind: "permanent",
      });
    }

    if (hosted.binding === undefined || hosted.status.state !== "ready") {
      throw new DeliveryError(
        `Frontend Binding ${bindingId} is ${hosted.status.state}`,
        { kind: hosted.status.state === "failed" ? "permanent" : "retryable" }
      );
    }

    await hosted.binding.deliver(delivery);
  };

  const forward = (bindingId: string, event: RunEvent): void => {
    const binding = bindings.get(bindingId)?.binding;

    try {
      binding?.onEvent?.(event);
    } catch {
      // `onEvent` must not throw. A broken adapter must not reach the event bus.
    }
  };

  const routeRunEvent: BusListener = (name, payload) => {
    if (name === "run.started" && "run" in payload) {
      const { origin } = payload.run;

      if (origin.kind === "chat" && bindings.has(origin.bindingId)) {
        const chat = { bindingId: origin.bindingId, chatId: origin.chatId };

        runChats.set(payload.run.runId, chat);
        forward(chat.bindingId, {
          chatId: chat.chatId,
          kind: "run_started",
          runId: payload.run.runId,
        });
      }

      return;
    }

    const runId = runIdOf(payload);

    const chat = runId === undefined ? undefined : runChats.get(runId);

    if (chat === undefined || runId === undefined) {
      return;
    }

    const event = runEventOf(name, payload, runId, chat.chatId);

    if (event !== undefined) {
      forward(chat.bindingId, event);
    }

    if (name === "run.finished") {
      runChats.delete(runId);
    }
  };

  const mount = async (
    ctx: AgentModuleContext,
    host: AgentHost
  ): Promise<MountedModule> => {
    await Promise.resolve();
    const stagingDir = path.join(ctx.agentDir, STAGING_DIR);

    const sinkFor = (bindingId: string): FrontendSink => ({
      command: async (command) => {
        await host.chat.command(
          { bindingId, chatId: command.chatId },
          command.name,
          command.args
        );
      },
      commands: BUILTIN_COMMANDS,
      decide: async (decision) =>
        await host.approvals.decide(decision.approvalId, decision.resolution, {
          bindingId,
          chatId: decision.chatId,
          kind: "chat",
        }),
      send: async (message) => {
        await host.chat.send(
          { bindingId, chatId: message.chatId },
          {
            interactive: true,
            senderDisplayName: message.senderDisplayName,
            text: inboundText(message.text, message.attachments),
          }
        );
      },
    });

    const contextFor = (hosted: HostedBinding): FrontendContext => {
      const { registerRoute } = options;

      const register =
        registerRoute === undefined
          ? undefined
          : (pathSuffix: string, handler: WebhookRouteHandler) => {
              const route = registerRoute(
                ctx.agentName,
                hosted.config.id,
                pathSuffix,
                handler
              );

              hosted.routes.push(route);

              return route;
            };

      return {
        agentName: ctx.agentName,
        bindingId: hosted.config.id,
        dataDir: path.join(ctx.agentDir, FRONTENDS_DIR, hosted.config.id),
        log: ctx.log,
        maxAttachmentBytes:
          options.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES,
        registerWebhookRoute: register,
        secrets: options.secrets,
        stagingDir,
      };
    };

    const createBinding = async (
      frontend: Frontend,
      hosted: HostedBinding
    ): Promise<FrontendBinding> => {
      const raw = hosted.config.config ?? {};

      if (!isJsonValue(raw)) {
        throw new Error("The binding config is not JSON");
      }

      const checked = await compileSchema(frontend.configSchema).check(raw);

      if (!checked.ok) {
        throw new Error(`Invalid config: ${checked.message}`);
      }

      const context = contextFor(hosted);

      await mkdir(context.dataDir, { recursive: true });
      await mkdir(context.stagingDir, { recursive: true });

      return await frontend.createBinding(raw, context);
    };

    const startOne = async (hosted: HostedBinding): Promise<void> => {
      const frontend = host.extensions.frontends().get(hosted.config.type);

      if (frontend === undefined) {
        hosted.status = failedStatus(
          hosted.config,
          `Unknown Frontend type: ${hosted.config.type}`
        );

        return;
      }

      try {
        hosted.binding = await createBinding(frontend, hosted);
        await hosted.binding.start(sinkFor(hosted.config.id));
        hosted.status = {
          id: hosted.config.id,
          state: "ready",
          type: hosted.config.type,
        };
      } catch (error) {
        const message = errorMessage(error);

        ctx.log.error("A Frontend Binding failed to start", {
          bindingId: hosted.config.id,
          error: message,
        });
        hosted.status = failedStatus(hosted.config, message);
      }
    };

    const onEvent: BusListener = (name, payload) => {
      if (!("agent" in payload) || payload.agent !== ctx.agentName) {
        return;
      }

      routeRunEvent(name, payload);
    };

    let unlisten: (() => void) | undefined;

    return {
      frontends: () => [...bindings.values()].map((hosted) => hosted.status),
      rpc: {},
      start: async () => {
        unlisten = options.events.listen(onEvent);
        await Promise.all([...bindings.values()].map(startOne));
      },
      stop: async () => {
        stopped = true;
        unlisten?.();
        await Promise.all(
          [...bindings.values()].map(async (hosted) => {
            for (const route of hosted.routes) {
              route.unregister();
            }

            try {
              await hosted.binding?.stop();
            } catch (error) {
              ctx.log.warn("A Frontend Binding failed to stop", {
                bindingId: hosted.config.id,
                error: errorMessage(error),
              });
            }

            hosted.binding = undefined;
            hosted.status = {
              id: hosted.config.id,
              state: "stopped",
              type: hosted.config.type,
            };
          })
        );
      },
    };
  };

  return {
    deliver: async (bindingId, delivery) => {
      if (stopped) {
        throw new DeliveryError("The Agent is stopping", { kind: "retryable" });
      }

      await deliver(bindingId, delivery);
    },
    mount,
  };
};
