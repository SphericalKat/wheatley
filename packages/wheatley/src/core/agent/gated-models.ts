import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  Api,
  Models,
} from "@earendil-works/pi-ai";

import type { ConcurrencyGate, GateLease } from "../concurrency-gate.js";

/** An error response for a request whose provider stream could not start. */
const failedResponse = (
  model: Model<Api>,
  message: string
): AssistantMessage => ({
  api: model.api,
  content: [],
  errorMessage: message,
  model: model.id,
  provider: model.provider,
  role: "assistant",
  stopReason: "error",
  timestamp: Date.now(),
  usage: {
    cacheRead: 0,
    cacheWrite: 0,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
    input: 0,
    output: 0,
    totalTokens: 0,
  },
});

/** Forwards `source` into `target` after the gate grants a slot of `key`, and frees the slot when the response ends. */
const pipeWithSlot = async (
  gate: ConcurrencyGate,
  model: Model<Api>,
  signal: AbortSignal | undefined,
  open: () => AssistantMessageEventStream,
  target: AssistantMessageEventStream
): Promise<void> => {
  let lease: GateLease | undefined;

  try {
    lease = await gate.acquire(model.provider, signal);
  } catch {
    // The request was aborted while it waited. The provider sees the aborted signal and ends the stream itself.
  }

  try {
    const source = open();

    for await (const event of source) {
      target.push(event);
    }

    target.end(await source.result());
  } catch (error) {
    const response = failedResponse(
      model,
      error instanceof Error ? error.message : String(error)
    );

    target.push({ error: response, reason: "error", type: "error" });
    target.end(response);
  } finally {
    lease?.release();
  }
};

/** Applies the `baseUrl` of the provider's `config.yaml` entry, if it has one. */
const withBaseUrl = <TApi extends Api>(
  model: Model<TApi>,
  baseUrlOf: (provider: string) => string | undefined
): Model<TApi> => {
  const baseUrl = baseUrlOf(model.provider);

  return baseUrl === undefined ? model : { ...model, baseUrl };
};

/**
 * Wraps pi-ai `Models` so that each model request first takes a Concurrency Gate slot of its provider. A parked Tool
 * call makes no request, so it holds no slot (ADR 0011). Requests also use the provider's configured `baseUrl`.
 */
export const gatedModels = (
  inner: Models,
  gate: ConcurrencyGate,
  baseUrlOf: (provider: string) => string | undefined
): Models => ({
  cancelDeferred: inner.cancelDeferred.bind(inner),
  checkAuth: inner.checkAuth.bind(inner),
  classify: inner.classify.bind(inner),
  complete: inner.complete.bind(inner),
  completeSimple: inner.completeSimple.bind(inner),
  fetchDeferred: inner.fetchDeferred.bind(inner),
  generateImages: inner.generateImages.bind(inner),
  getAllAvailable: inner.getAllAvailable.bind(inner),
  getAllModels: inner.getAllModels.bind(inner),
  getAuth: inner.getAuth.bind(inner),
  getAvailable: inner.getAvailable.bind(inner),
  getAvailableOfType: inner.getAvailableOfType.bind(inner),
  getModel: inner.getModel.bind(inner),
  getModelOfType: inner.getModelOfType.bind(inner),
  getModels: inner.getModels.bind(inner),
  getModelsOfType: inner.getModelsOfType.bind(inner),
  getProvider: inner.getProvider.bind(inner),
  getProviders: inner.getProviders.bind(inner),
  login: inner.login.bind(inner),
  logout: inner.logout.bind(inner),
  refresh: inner.refresh.bind(inner),
  stream: (model, context, options) => {
    const target = createAssistantMessageEventStream();

    void pipeWithSlot(
      gate,
      model,
      options?.signal,
      () => inner.stream(withBaseUrl(model, baseUrlOf), context, options),
      target
    );

    return target;
  },
  streamDeferred: inner.streamDeferred.bind(inner),
  streamSimple: (model, context, options) => {
    const target = createAssistantMessageEventStream();

    void pipeWithSlot(
      gate,
      model,
      options?.signal,
      () => inner.streamSimple(withBaseUrl(model, baseUrlOf), context, options),
      target
    );

    return target;
  },
});
