import { RpcErrorCode } from "@wheatley/protocol";
import { describe, expect, it } from "vitest";

import { SeamError, toRpcError } from "./errors.js";

describe("toRpcError", () => {
  it("keeps the message and details of a seam error", () => {
    const error = toRpcError(
      new SeamError("revision_conflict", "config.yaml changed", {
        revision: "r2",
      })
    );

    expect(error.toObject()).toStrictEqual({
      code: RpcErrorCode.RevisionConflict,
      data: { revision: "r2" },
      message: "config.yaml changed",
    });
  });

  it("maps a missing target to NotFound", () => {
    expect(toRpcError(new SeamError("not_found", "Unknown Trigger")).code).toBe(
      RpcErrorCode.NotFound
    );
  });
});
