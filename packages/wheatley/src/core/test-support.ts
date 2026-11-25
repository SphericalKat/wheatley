// Shared setup for core tests: a fake LLM provider at the pi-ai boundary and the in-memory extension catalog.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { FauxProviderHandle, MutableModels } from "@earendil-works/pi-ai";
import type { EventName, EventPayload } from "@wheatley/protocol";
import type { Logger } from "@wheatley/sdk";

import { InMemoryExtensionCatalog } from "../contracts/extension-catalog.fake.js";
import { createBuiltinToolProvider } from "../tools/builtin-tools.js";

/** The provider name of the fake LLM. */
export const FAKE_PROVIDER = "faux";

/** A fake LLM provider and the `Models` that serve it. */
export interface FakeLlm {
  readonly faux: FauxProviderHandle;
  readonly models: MutableModels;
  readonly modelId: string;
}

/** Creates a fake LLM provider whose responses the test scripts with `faux.setResponses`. */
export const createFakeLlm = (): FakeLlm => {
  const faux = fauxProvider({ provider: FAKE_PROVIDER });
  const models = createModels();

  models.setProvider(faux.provider);

  return { faux, modelId: faux.getModel().id, models };
};

/** An extension catalog that gives every Agent its own built-in Tools. */
export const builtinCatalog = (): InMemoryExtensionCatalog =>
  new InMemoryExtensionCatalog(() => ({
    builtin: createBuiltinToolProvider(),
  }));

/** Does nothing. Tests pass it where a callback must exist but its calls do not matter. */
export const ignore = (): void => {
  // The test does not observe this callback.
};

/** A logger that drops every record. */
export const silentLogger: Logger = {
  debug: ignore,
  error: ignore,
  info: ignore,
  warn: ignore,
};

/** Creates a temporary folder and returns it with its cleanup. */
export const temporaryDir = async (): Promise<{
  readonly dir: string;
  readonly remove: () => Promise<void>;
}> => {
  const dir = await mkdtemp(path.join(tmpdir(), "wheatley-core-"));

  return {
    dir,
    remove: async () => {
      await rm(dir, { force: true, recursive: true });
    },
  };
};

/** One recorded event. */
export interface RecordedEvent {
  readonly name: EventName;
  readonly payload: EventPayload<EventName>;
}

/** Records emitted events in order. */
export class EventRecorder {
  readonly events: RecordedEvent[] = [];

  readonly emit = <E extends EventName>(
    name: E,
    payload: EventPayload<E>
  ): void => {
    this.events.push({ name, payload });
  };

  /** The payloads of one event name, in order. */
  readonly of = <E extends EventName>(name: E): EventPayload<E>[] =>
    this.events.flatMap((event) =>
      event.name === name && isPayloadOf(name, event) ? [event.payload] : []
    );
}

const isPayloadOf = <E extends EventName>(
  name: E,
  event: RecordedEvent
): event is { readonly name: E; readonly payload: EventPayload<E> } =>
  event.name === name;
