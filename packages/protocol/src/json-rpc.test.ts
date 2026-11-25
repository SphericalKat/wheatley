import {
  decodeClientMessage,
  decodeServerMessage,
  encodeError,
  encodeEvent,
  encodeRequest,
  encodeResult,
  RpcErrorCode,
} from "@wheatley-ai/protocol";
import type { JsonObject, MethodName, RpcId } from "@wheatley-ai/protocol";
import { describe, expect, it } from "vitest";

const request = (body: JsonObject): string =>
  JSON.stringify({ jsonrpc: "2.0", ...body });

const noPending = (): MethodName | undefined => undefined;

describe("decodeClientMessage", () => {
  it("decodes a request with params that match the method schema", () => {
    expect(
      decodeClientMessage(encodeRequest(7, "agents.get", { agent: "home" }))
    ).toStrictEqual({
      ok: true,
      request: { id: 7, method: "agents.get", params: { agent: "home" } },
    });
  });

  it("decodes absent params as an empty object", () => {
    expect(
      decodeClientMessage(request({ id: "a", method: "system.status" }))
    ).toStrictEqual({
      ok: true,
      request: { id: "a", method: "system.status", params: {} },
    });
  });

  it("reports a parse error with a null ID", () => {
    expect(decodeClientMessage("{not json")).toStrictEqual({
      error: { code: RpcErrorCode.ParseError, message: "Parse error" },
      id: null,
      ok: false,
    });
  });

  it("reports an invalid envelope and keeps a readable ID", () => {
    const decoded = decodeClientMessage(
      JSON.stringify({ id: 3, method: "agents.list" })
    );

    expect(decoded).toMatchObject({
      error: { code: RpcErrorCode.InvalidRequest },
      id: 3,
      ok: false,
    });
  });

  it("rejects a request without an ID", () => {
    const decoded = decodeClientMessage(request({ method: "agents.list" }));

    expect(decoded).toMatchObject({
      error: { code: RpcErrorCode.InvalidRequest },
      id: null,
      ok: false,
    });
  });

  it("reports an unknown method", () => {
    const decoded = decodeClientMessage(
      request({ id: 1, method: "agents.explode", params: {} })
    );

    expect(decoded).toMatchObject({
      error: { code: RpcErrorCode.MethodNotFound },
      id: 1,
      ok: false,
    });
  });

  it("reports invalid params with JSON Pointer paths", () => {
    const decoded = decodeClientMessage(
      request({
        id: 2,
        method: "memory.read",
        params: { agent: "Home!", name: "../etc" },
      })
    );

    expect(decoded.ok).toBe(false);
    expect(decoded).toMatchObject({
      error: { code: RpcErrorCode.InvalidParams },
      id: 2,
    });
    expect(JSON.stringify(decoded)).toContain('"path":"/agent"');
    expect(JSON.stringify(decoded)).toContain('"path":"/name"');
  });

  it("rejects unknown params fields", () => {
    const decoded = decodeClientMessage(
      request({
        id: 4,
        method: "agents.get",
        params: { agent: "home", agnet: "typo" },
      })
    );

    expect(decoded).toMatchObject({
      error: { code: RpcErrorCode.InvalidParams },
      ok: false,
    });
  });

  it("accepts either raw YAML or a structured config for config.save", () => {
    const raw = decodeClientMessage(
      encodeRequest(5, "config.save", {
        expectedRevision: "r1",
        raw: "version: 1\nagents: {}\n",
      })
    );

    const neither = decodeClientMessage(
      request({
        id: 6,
        method: "config.save",
        params: { expectedRevision: "r1" },
      })
    );

    expect(raw.ok).toBe(true);
    expect(neither).toMatchObject({
      error: { code: RpcErrorCode.InvalidParams },
      ok: false,
    });
  });
});

describe("decodeServerMessage", () => {
  it("validates a result against the method of its pending request", () => {
    const pending = new Map<RpcId, MethodName>([[9, "runs.stop"]]);
    const text = encodeResult(9, "runs.stop", { stopped: true });

    expect(decodeServerMessage(text, (id) => pending.get(id))).toStrictEqual({
      kind: "result",
      response: { id: 9, method: "runs.stop", result: { stopped: true } },
    });
  });

  it("rejects a result for an unknown request ID", () => {
    const text = encodeResult(9, "runs.stop", { stopped: true });

    expect(decodeServerMessage(text, noPending)).toMatchObject({
      kind: "invalid",
    });
  });

  it("rejects a result that does not match the method schema", () => {
    const text = JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      result: { stopped: "yes" },
    });

    expect(decodeServerMessage(text, () => "runs.stop")).toMatchObject({
      kind: "invalid",
    });
  });

  it("decodes an error response", () => {
    const text = encodeError(1, {
      code: RpcErrorCode.RevisionConflict,
      data: { revision: "r2" },
      message: "Stale",
    });

    expect(decodeServerMessage(text, noPending)).toStrictEqual({
      error: {
        code: RpcErrorCode.RevisionConflict,
        data: { revision: "r2" },
        message: "Stale",
      },
      id: 1,
      kind: "error",
    });
  });

  it("decodes an event notification", () => {
    const payload = {
      agent: "home",
      approvalId: "ap-1",
      decision: "allow_once",
      resolvedBy: "Ana",
    } as const;

    expect(
      decodeServerMessage(encodeEvent("approval.resolved", payload), noPending)
    ).toStrictEqual({
      event: { name: "approval.resolved", payload },
      kind: "event",
    });
  });

  it("rejects an event whose payload does not match its schema", () => {
    const text = JSON.stringify({
      jsonrpc: "2.0",
      method: "run.delta",
      params: { agent: "home" },
    });

    expect(decodeServerMessage(text, noPending)).toMatchObject({
      kind: "invalid",
    });
  });
});

describe("encodeResult", () => {
  it("throws if a handler returns a result that does not match the method schema", () => {
    expect(() =>
      // @ts-expect-error -- The test sends a wrong result on purpose to check the runtime guard.
      encodeResult(1, "runs.stop", { stopped: "yes" })
    ).toThrow("runs.stop");
  });
});
