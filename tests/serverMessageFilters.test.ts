import { describe, expect, it } from "vitest";
import {
  countFilterMatches,
  hasMessageSelection,
  matchesCriteria,
  validateMessageCriteria,
  validateMessagePageSize,
} from "../convex/lib/messageFilters";
import type { ChatMessage } from "../src/api";
import type { MessageFilter } from "../shared/messageFilters";

const moderatorFilter: MessageFilter = {
  id: "moderators",
  name: "Moderators",
  action: "show",
  match: "all",
  rules: [{ id: "role", field: "role", operator: "equals", value: "moderator" }],
};

const messages = [
  makeMessage({ _id: "mod", senderUsername: "alice", isModerator: true }),
  makeMessage({ _id: "viewer", senderUsername: "bob" }),
];

describe("server message filtering", () => {
  it("validates criteria and applies quick search with selection filters", () => {
    const criteria = validateMessageCriteria({
      quickSearch: "alice",
      filters: [moderatorFilter],
      afterTimestamp: 10,
    });

    expect(hasMessageSelection(criteria)).toBe(true);
    expect(messages.filter((message) => matchesCriteria(message, criteria)))
      .toEqual([messages[0]]);
    expect(criteria.afterTimestamp).toBe(10);
  });

  it("does not treat highlight-only filters as server selection", () => {
    const criteria = validateMessageCriteria({
      filters: [{ ...moderatorFilter, action: "highlight" }],
    });

    expect(hasMessageSelection(criteria)).toBe(false);
    expect(messages.every((message) => matchesCriteria(message, criteria))).toBe(true);
  });

  it("computes all saved-filter counts in one server pass", () => {
    expect(countFilterMatches(messages, [moderatorFilter])).toEqual([
      { id: "moderators", count: 1 },
    ]);
  });

  it("rejects invalid or mismatched rules at the server boundary", () => {
    expect(() => validateMessageCriteria({
      filters: [{
        ...moderatorFilter,
        rules: [{ id: "bad", field: "role", operator: "contains", value: "mod" }],
      }],
    })).toThrow("invalid rule");
    expect(() => validateMessagePageSize(251)).toThrow("limited to 250");
  });
});

function makeMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    _id: "message",
    externalChannelId: "100",
    channelName: "channel",
    senderUsername: "viewer",
    senderDisplayName: "Viewer",
    messageText: "message",
    timestamp: 1,
    badges: [],
    isBroadcaster: false,
    isModerator: false,
    isSubscriber: false,
    isVip: false,
    messageType: "text",
    ...overrides,
  };
}
