import { DeliveryError, isDeliveryError } from "@wheatley/sdk";
import { describe, expect, it } from "vitest";

describe("isDeliveryError", () => {
  it("matches a DeliveryError and keeps its retry hint", () => {
    const error = new DeliveryError("rate limited", {
      kind: "retryable",
      retryAfterMs: 5000,
    });

    expect(isDeliveryError(error)).toBe(true);
    expect(error.retryAfterMs).toBe(5000);
  });

  it("matches an error from another copy of the SDK by name and kind", () => {
    const foreign = Object.assign(new Error("chat deleted"), {
      kind: "permanent",
      name: "DeliveryError",
    });

    expect(isDeliveryError(foreign)).toBe(true);
  });

  it("does not match other errors", () => {
    expect(isDeliveryError(new Error("network"))).toBe(false);
    expect(isDeliveryError("DeliveryError")).toBe(false);
  });
});
