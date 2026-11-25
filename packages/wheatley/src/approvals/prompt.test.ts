import { createInterface } from "node:readline/promises";
import { PassThrough } from "node:stream";

import type { PendingApproval } from "@wheatley/protocol";
import { describe, expect, it } from "vitest";

import { promptForApproval, renderApprovalPrompt } from "./prompt.js";

const NOW = Date.parse("2026-11-26T09:00:00.000Z");

const approval: PendingApproval = {
  agent: "home",
  approvalId: "a1",
  chat: null,
  conversationId: "conversation-1",
  createdAt: "2026-11-26T09:00:00.000Z",
  expiresAt: "2026-11-26T09:15:00.000Z",
  inputPreview: '{"command":"rm -rf build"}',
  runId: "run-1",
  toolName: "shell",
};

/** Answers questions from a script and records each query. */
const scripted = (answers: string[]) => {
  const queries: string[] = [];

  const question = async (query: string): Promise<string> => {
    await Promise.resolve();
    queries.push(query);
    const answer = answers.shift();

    if (answer === undefined) {
      throw new Error("No scripted answer left");
    }

    return answer;
  };

  return { queries, question };
};

const clock = { now: () => NOW };

describe("CLI Approval prompt", () => {
  it("renders the Tool, the redacted preview, the deadline, and the choices", () => {
    expect(renderApprovalPrompt(approval, NOW)).toBe(
      [
        "Approval needed: shell",
        'Input: {"command":"rm -rf build"}',
        "Times out in 15m 0s (2026-11-26T09:15:00.000Z)",
        "[o] allow once  [c] allow for this conversation  [a] always allow  [d] deny",
      ].join("\n")
    );
    expect(
      renderApprovalPrompt({ ...approval, expiresAt: null }, NOW)
    ).toContain("No timeout");
  });

  it.each([
    ["o", "allow_once"],
    ["Conversation", "allow_conversation"],
    [" a ", "allow_always"],
  ] as const)("maps %j to %s", async (answer, decision) => {
    const { question } = scripted([answer]);

    await expect(
      promptForApproval(approval, { clock, question, resolvedBy: "Operator" })
    ).resolves.toStrictEqual({ decision, resolvedBy: "Operator" });
  });

  it("asks again after an invalid answer and asks for an optional deny reason", async () => {
    const { queries, question } = scripted(["maybe", "d", "  too risky  "]);

    await expect(
      promptForApproval(approval, { clock, question })
    ).resolves.toStrictEqual({ decision: "deny", reason: "too risky" });
    expect(queries[1]).toBe("Answer o, c, a, or d: ");
    expect(queries[2]).toContain("Reason");
  });

  it("omits an empty deny reason", async () => {
    const { question } = scripted(["no", ""]);

    await expect(
      promptForApproval(approval, { clock, question })
    ).resolves.toStrictEqual({ decision: "deny" });
  });

  it("resolves undefined when another surface decides first", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const rl = createInterface({ input, output, terminal: false });
    const controller = new AbortController();

    try {
      const prompt = promptForApproval(approval, {
        clock,
        question: async (query, options) => await rl.question(query, options),
        signal: controller.signal,
      });

      controller.abort();

      await expect(prompt).resolves.toBeUndefined();
    } finally {
      rl.close();
    }
  });

  it("reads the answer from a real readline interface", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const rl = createInterface({ input, output, terminal: false });

    try {
      const prompt = promptForApproval(approval, {
        clock,
        question: async (query, options) => await rl.question(query, options),
      });

      input.write("c\n");

      await expect(prompt).resolves.toStrictEqual({
        decision: "allow_conversation",
      });
      expect(String(output.read())).toContain("Approval needed: shell");
    } finally {
      rl.close();
    }
  });
});
