import type {
  ChatPostMessageArguments,
  ChatUpdateArguments,
  FilesUploadV2Arguments,
  ReactionsAddArguments,
  ReactionsRemoveArguments,
} from "@slack/web-api";

import type { SlackWebClient } from "./slack-client.js";

/** One recorded Web API call of `FakeSlackWebClient`. */
export type SlackCall =
  | {
      readonly method: "chat.postMessage";
      readonly args: ChatPostMessageArguments;
    }
  | { readonly method: "chat.update"; readonly args: ChatUpdateArguments }
  | { readonly method: "reactions.add"; readonly args: ReactionsAddArguments }
  | {
      readonly method: "reactions.remove";
      readonly args: ReactionsRemoveArguments;
    }
  | { readonly method: "filesUploadV2"; readonly args: FilesUploadV2Arguments };

/** The Web API methods that `FakeSlackWebClient.failNext` can fail. */
export type SlackMethod = SlackCall["method"];

/** A fake `WebClient`: it records every call and returns increasing message timestamps. */
export class FakeSlackWebClient implements SlackWebClient {
  readonly calls: SlackCall[] = [];
  readonly botUserId: string;
  readonly #failures = new Map<SlackMethod, (Error | undefined)[]>();
  readonly #names: ReadonlyMap<string, string>;
  #nextTs = 1;

  constructor(botUserId: string, names: Readonly<Record<string, string>> = {}) {
    this.botUserId = botUserId;
    this.#names = new Map(Object.entries(names));
  }

  readonly auth = {
    test: async () => {
      await Promise.resolve();

      return { user_id: this.botUserId };
    },
  };

  readonly chat = {
    postMessage: async (args: ChatPostMessageArguments) => {
      await this.#record({ args, method: "chat.postMessage" });
      const ts = `1000.${String(this.#nextTs).padStart(6, "0")}`;
      this.#nextTs += 1;

      return { ts };
    },
    update: async (args: ChatUpdateArguments) => {
      await this.#record({ args, method: "chat.update" });

      return { ok: true };
    },
  };

  readonly reactions = {
    add: async (args: ReactionsAddArguments) => {
      await this.#record({ args, method: "reactions.add" });

      return { ok: true };
    },
    remove: async (args: ReactionsRemoveArguments) => {
      await this.#record({ args, method: "reactions.remove" });

      return { ok: true };
    },
  };

  readonly users = {
    info: async ({ user }: { readonly user: string }) => {
      await Promise.resolve();
      const name = this.#names.get(user);

      return name === undefined
        ? {}
        : { user: { profile: { display_name: name } } };
    },
  };

  readonly filesUploadV2 = async (args: FilesUploadV2Arguments) => {
    await this.#record({ args, method: "filesUploadV2" });

    return { ok: true };
  };

  /** Makes a later call of `method` reject with `error`: the next call, or the call after `skip` successful calls. */
  readonly failNext = (method: SlackMethod, error: Error, skip = 0): void => {
    const queue = this.#failures.get(method) ?? [];

    queue.push(
      ...Array.from({ length: skip }, (): undefined => undefined),
      error
    );
    this.#failures.set(method, queue);
  };

  /** The recorded `chat.postMessage` arguments. */
  readonly posts = (): ChatPostMessageArguments[] =>
    this.calls.flatMap((call) =>
      call.method === "chat.postMessage" ? [call.args] : []
    );

  /** The recorded `chat.update` arguments. */
  readonly updates = (): ChatUpdateArguments[] =>
    this.calls.flatMap((call) =>
      call.method === "chat.update" ? [call.args] : []
    );

  /** The recorded `reactions.add` arguments. */
  readonly reactionsAdded = (): ReactionsAddArguments[] =>
    this.calls.flatMap((call) =>
      call.method === "reactions.add" ? [call.args] : []
    );

  /** The recorded `reactions.remove` arguments. */
  readonly reactionsRemoved = (): ReactionsRemoveArguments[] =>
    this.calls.flatMap((call) =>
      call.method === "reactions.remove" ? [call.args] : []
    );

  /** The recorded `filesUploadV2` arguments. */
  readonly uploads = (): FilesUploadV2Arguments[] =>
    this.calls.flatMap((call) =>
      call.method === "filesUploadV2" ? [call.args] : []
    );

  readonly #record = async (call: SlackCall): Promise<void> => {
    await Promise.resolve();
    const failure = this.#failures.get(call.method)?.shift();

    if (failure !== undefined) {
      throw failure;
    }

    this.calls.push(call);
  };
}
