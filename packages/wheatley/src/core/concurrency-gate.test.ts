import { describe, expect, it } from "vitest";

import { ConcurrencyGate } from "./concurrency-gate.js";

describe("ConcurrencyGate", () => {
  it("grants slots up to the limit and serves waiters in call order", async () => {
    const gate = new ConcurrencyGate(() => 2);
    const granted: string[] = [];
    const first = await gate.acquire("anthropic");
    const second = await gate.acquire("anthropic");

    const third = gate.acquire("anthropic").then((lease) => {
      granted.push("third");

      return lease;
    });

    const fourth = gate.acquire("anthropic").then((lease) => {
      granted.push("fourth");

      return lease;
    });

    await Promise.resolve();
    expect(gate.pressure()).toStrictEqual([
      { credential: "anthropic", inUse: 2, limit: 2, waiting: 2 },
    ]);

    first.release();
    first.release();
    const thirdLease = await third;

    thirdLease.release();
    second.release();
    const fourthLease = await fourth;

    fourthLease.release();

    expect(granted).toStrictEqual(["third", "fourth"]);
    expect(gate.pressure()).toStrictEqual([
      { credential: "anthropic", inUse: 0, limit: 2, waiting: 0 },
    ]);
  });

  it("keeps keys apart and drops a waiter whose signal aborts", async () => {
    const gate = new ConcurrencyGate(() => 1);
    const held = await gate.acquire("anthropic");
    const other = await gate.acquire("openai");
    const abort = new AbortController();
    const waiting = gate.acquire("anthropic", abort.signal);

    abort.abort(new Error("stopped"));

    await expect(waiting).rejects.toThrow("stopped");
    expect(gate.pressure()).toStrictEqual([
      { credential: "anthropic", inUse: 1, limit: 1, waiting: 0 },
      { credential: "openai", inUse: 1, limit: 1, waiting: 0 },
    ]);

    held.release();
    other.release();
  });
});
