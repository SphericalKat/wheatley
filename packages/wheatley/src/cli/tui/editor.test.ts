import { expect, it } from "vitest";

import {
  deleteToLineEnd,
  deleteToLineStart,
  deleteWordBackward,
  draftOf,
  EMPTY_DRAFT,
  HISTORY_START,
  insert,
  moveHome,
  moveVertical,
  moveWordLeft,
  stepHistory,
} from "./editor.js";

it("deletes the word before the cursor, and the text before or after it on the line", () => {
  const draft = draftOf("git commit --amend");

  expect(deleteWordBackward(draft)).toStrictEqual({
    cursor: 13,
    text: "git commit --",
  });
  expect(deleteToLineStart(moveWordLeft(draft))).toStrictEqual({
    cursor: 0,
    text: "amend",
  });
  expect(deleteToLineEnd(moveHome(draft))).toStrictEqual({
    cursor: 0,
    text: "",
  });
});

it("moves between lines of a multi-line draft and keeps the column", () => {
  const draft = draftOf("first line\nok\nthird line");

  const up = moveVertical(draft, -1);

  expect(up.cursor).toBe("first line\nok".length);
  expect(moveVertical(up, -1).cursor).toBe(2);
});

it("walks back through history and restores the unsent draft at the end", () => {
  const history = ["newest", "older"];
  const draft = insert(EMPTY_DRAFT, "half typed");

  const first = stepHistory(history, HISTORY_START, draft, 1);
  const second = first && stepHistory(history, first.cursor, first.draft, 1);
  const back = second && stepHistory(history, second.cursor, second.draft, -1);
  const restored = back && stepHistory(history, back.cursor, back.draft, -1);

  expect([
    first?.draft.text,
    second?.draft.text,
    back?.draft.text,
    restored?.draft.text,
  ]).toStrictEqual(["newest", "older", "newest", "half typed"]);
  expect(
    second && stepHistory(history, second.cursor, second.draft, 1)
  ).toBeUndefined();
});
