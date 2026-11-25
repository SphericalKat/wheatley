import { expect, test } from "vitest";

import { formatRoute, parseRoute } from "./router.js";

test("round-trips Deployment and Agent routes through the URL hash", () => {
  expect(parseRoute(formatRoute({ view: "inbox" }))).toEqual({ view: "inbox" });
  expect(parseRoute(formatRoute({ agent: "home", view: "config" }))).toEqual({
    agent: "home",
    view: "config",
  });
});

test("opens the Chat of an Agent without a view and the Overview for unknown hashes", () => {
  expect(parseRoute("#/agents/work")).toEqual({ agent: "work", view: "chat" });
  expect(parseRoute("#/agents/work/unknown")).toEqual({ view: "overview" });
  expect(parseRoute("")).toEqual({ view: "overview" });
});
