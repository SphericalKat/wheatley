import { SeamError } from "./errors.js";
import { simulateIo } from "./fake-io.js";
import type {
  MaintenanceRunner,
  MaintenanceRunRequest,
  MaintenanceRunResult,
} from "./maintenance-runner.js";

/** Computes the result of one fake maintenance Run. */
export type FakeMaintenanceResponder = (
  request: MaintenanceRunRequest
) => MaintenanceRunResult | Promise<MaintenanceRunResult>;

/** An in-memory `MaintenanceRunner` that ends each Run with the result of `respond`. */
export class InMemoryMaintenanceRunner implements MaintenanceRunner {
  readonly #respond: FakeMaintenanceResponder;
  readonly #runs = new Map<
    string,
    {
      readonly request: MaintenanceRunRequest;
      readonly result: Promise<MaintenanceRunResult>;
    }
  >();

  constructor(
    respond: FakeMaintenanceResponder = () => ({
      status: "completed",
      text: "",
    })
  ) {
    this.#respond = respond;
  }

  /** The started requests in start order, for test assertions. */
  get requests(): readonly MaintenanceRunRequest[] {
    return [...this.#runs.values()].map(({ request }) => request);
  }

  readonly start = async (
    request: MaintenanceRunRequest
  ): Promise<{ readonly runId: string }> => {
    await simulateIo();
    const runId = `maintenance-run-${this.#runs.size + 1}`;

    const result = (async () => {
      await simulateIo();

      return await this.#respond(request);
    })();

    this.#runs.set(runId, { request, result });

    return { runId };
  };

  readonly wait = async (runId: string): Promise<MaintenanceRunResult> => {
    await simulateIo();
    const run = this.#runs.get(runId);

    if (run === undefined) {
      throw new SeamError("not_found", `Unknown maintenance Run ${runId}`);
    }

    return await run.result;
  };
}
