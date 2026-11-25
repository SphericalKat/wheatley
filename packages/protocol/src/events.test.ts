import {
  EVENT_NAMES,
  eventTopic,
  EventTopicSchema,
  decode,
} from "@wheatley-ai/protocol";
import { describe, expect, it } from "vitest";

describe("eventTopic", () => {
  it("maps every event to a subscribable topic", () => {
    for (const name of EVENT_NAMES) {
      expect(decode(EventTopicSchema, eventTopic(name)).ok).toBe(true);
    }
  });

  it("uses the part before the dot", () => {
    expect(eventTopic("approval.requested")).toBe("approval");
    expect(eventTopic("run.toolFinished")).toBe("run");
  });
});
