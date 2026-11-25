// A Frontend whose platform transport is in memory: the test plays the Sender through `send`, `command`, and `decide`,
// and reads what the Agent delivered to each Chat.
import type {
  ApprovalResolution,
  CommandName,
  Delivery,
  Frontend,
  FrontendBinding,
  FrontendContext,
  FrontendSink,
  RunEvent,
} from "@wheatley-ai/sdk";
import { DeliveryError } from "@wheatley-ai/sdk";

/** The `type` of the fake Frontend in `config.yaml`. */
export const FAKE_FRONTEND_TYPE = "fake";

/** One running fake binding, as the test sees it. */
export interface FakeBindingHandle {
  readonly agentName: string;
  readonly bindingId: string;
  readonly context: FrontendContext;
  /** Durable deliveries, in delivery order. */
  readonly deliveries: Delivery[];
  /** Live Run progress, in arrival order. */
  readonly events: RunEvent[];
  readonly running: () => boolean;
}

/** A failure that the next `deliver` calls of a binding throw. */
export interface DeliveryFailure {
  readonly kind: "retryable" | "permanent";
  /** How many calls fail. The default is 1. */
  readonly times?: number;
}

/** The fake Frontend and the controls of its bindings. */
export interface FakeFrontend {
  /** Pass it in `HarnessOptions.frontends`, or use the harness default. */
  readonly frontend: Frontend;
  /** The binding `bindingId` of `agent`. Throws if it did not start. */
  readonly binding: (agent: string, bindingId: string) => FakeBindingHandle;
  /** Sends a user message from `chatId`, as a Sender would. Resolves once the Agent stored it. */
  readonly send: (
    agent: string,
    bindingId: string,
    chatId: string,
    text: string,
    senderDisplayName?: string
  ) => Promise<void>;
  /** Sends a built-in command, for example `/new`. */
  readonly command: (
    agent: string,
    bindingId: string,
    chatId: string,
    name: CommandName,
    args?: string
  ) => Promise<void>;
  /** Decides an Approval from `chatId`. Resolves `true` if this decision won. */
  readonly decide: (
    agent: string,
    bindingId: string,
    chatId: string,
    approvalId: string,
    resolution: ApprovalResolution
  ) => Promise<boolean>;
  /** Makes the next `deliver` calls of a binding fail, to test outbox retries and failures. */
  readonly failDeliveries: (
    agent: string,
    bindingId: string,
    failure: DeliveryFailure
  ) => void;
}

interface FakeBindingState extends FakeBindingHandle {
  sink: FrontendSink | undefined;
  failure: { kind: DeliveryFailure["kind"]; remaining: number } | undefined;
  stopped: boolean;
}

const keyOf = (agent: string, bindingId: string): string =>
  `${agent}/${bindingId}`;

/** Creates a fake Frontend. Each binding records its deliveries and exposes its sink. */
export const createFakeFrontend = (
  type: string = FAKE_FRONTEND_TYPE
): FakeFrontend => {
  const bindings = new Map<string, FakeBindingState>();

  const stateOf = (agent: string, bindingId: string): FakeBindingState => {
    const state = bindings.get(keyOf(agent, bindingId));

    if (state === undefined) {
      throw new Error(`No fake binding ${bindingId} for Agent ${agent}`);
    }

    return state;
  };

  const sinkOf = (agent: string, bindingId: string): FrontendSink => {
    const { sink, stopped } = stateOf(agent, bindingId);

    if (sink === undefined || stopped) {
      throw new Error(`The fake binding ${bindingId} is not running`);
    }

    return sink;
  };

  const frontend: Frontend = {
    configSchema: { type: "object" },
    createBinding: (_config, context): FrontendBinding => {
      const state: FakeBindingState = {
        agentName: context.agentName,
        bindingId: context.bindingId,
        context,
        deliveries: [],
        events: [],
        failure: undefined,
        running: () => state.sink !== undefined && !state.stopped,
        sink: undefined,
        stopped: false,
      };

      bindings.set(keyOf(context.agentName, context.bindingId), state);

      return {
        deliver: async (delivery) => {
          await Promise.resolve();

          if (state.failure !== undefined && state.failure.remaining > 0) {
            state.failure.remaining -= 1;
            throw new DeliveryError("The fake transport failed", {
              kind: state.failure.kind,
            });
          }

          state.deliveries.push(delivery);
        },
        onEvent: (event) => {
          state.events.push(event);
        },
        start: async (sink) => {
          await Promise.resolve();
          state.sink = sink;
        },
        stop: async () => {
          await Promise.resolve();
          state.stopped = true;
        },
      };
    },
    type,
  };

  return {
    binding: stateOf,
    command: async (agent, bindingId, chatId, name, args) => {
      await sinkOf(agent, bindingId).command({ args, chatId, name });
    },
    decide: async (agent, bindingId, chatId, approvalId, resolution) =>
      await sinkOf(agent, bindingId).decide({ approvalId, chatId, resolution }),
    failDeliveries: (agent, bindingId, failure) => {
      stateOf(agent, bindingId).failure = {
        kind: failure.kind,
        remaining: failure.times ?? 1,
      };
    },
    frontend,
    send: async (agent, bindingId, chatId, text, senderDisplayName) => {
      await sinkOf(agent, bindingId).send({ chatId, senderDisplayName, text });
    },
  };
};
