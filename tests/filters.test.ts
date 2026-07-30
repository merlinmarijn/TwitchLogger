import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../src/api";
import {
  applyMessageFilters,
  filterRuleError,
  matchesMessageFilter,
  parseFilterState,
  type MessageFilter,
} from "../src/filters";

const messages = [
  makeMessage({
    _id: "one",
    messageText: "Hello chat",
    senderUsername: "friendly_mod",
    isModerator: true,
    badges: [{ setId: "moderator", id: "1", info: "" }],
  }),
  makeMessage({
    _id: "two",
    messageText: "!command spam",
    senderUsername: "viewer",
  }),
];

describe("message filters", () => {
  it("treats a filter without conditions as matching every message", () => {
    const filter = makeFilter({ rules: [] });
    expect(messages.every((message) => matchesMessageFilter(message, filter))).toBe(true);
  });

  it("supports all/any conditions across message metadata", () => {
    const filter = makeFilter({
      match: "all",
      rules: [
        { id: "a", field: "role", operator: "equals", value: "moderator" },
        { id: "b", field: "message", operator: "contains", value: "hello" },
      ],
    });
    expect(matchesMessageFilter(messages[0], filter)).toBe(true);
    expect(matchesMessageFilter(messages[1], filter)).toBe(false);
  });

  it("matches an exact sender against either username or display name", () => {
    expect(matchesMessageFilter(messages[0], makeFilter({
      rules: [{ id: "sender", field: "sender", operator: "equals", value: "friendly_mod" }],
    }))).toBe(true);
    expect(matchesMessageFilter(messages[0], makeFilter({
      rules: [{ id: "sender", field: "sender", operator: "equals", value: "friendly" }],
    }))).toBe(false);
  });

  it("filters messages by supported image links", () => {
    const withImages = makeFilter({
      rules: [{ id: "image", field: "image", operator: "has", value: "image" }],
    });
    const withoutImages = makeFilter({
      rules: [{ id: "image", field: "image", operator: "notHas", value: "image" }],
    });
    const imageMessage = makeMessage({
      messageText: "look https://example.test/artwork.webp",
    });

    expect(matchesMessageFilter(imageMessage, withImages)).toBe(true);
    expect(matchesMessageFilter(messages[0], withImages)).toBe(false);
    expect(matchesMessageFilter(imageMessage, withoutImages)).toBe(false);
  });

  it("matches whole words next to punctuation without treating values as regex", () => {
    expect(matchesMessageFilter(messages[0], makeFilter({
      rules: [{ id: "word", field: "message", operator: "wholeWord", value: "chat" }],
    }))).toBe(true);
    expect(matchesMessageFilter(
      makeMessage({ messageText: "Use C++!" }),
      makeFilter({
        rules: [{ id: "word", field: "message", operator: "wholeWord", value: "C++" }],
      }),
    )).toBe(true);
  });

  it("supports plain case-insensitive regex and delimited expressions with flags", () => {
    expect(matchesMessageFilter(messages[0], makeFilter({
      rules: [{ id: "regex", field: "message", operator: "regex", value: "^hello\\s+chat$" }],
    }))).toBe(true);
    expect(matchesMessageFilter(messages[0], makeFilter({
      rules: [{ id: "regex", field: "message", operator: "regex", value: "/^hello/" }],
    }))).toBe(false);
    expect(matchesMessageFilter(messages[0], makeFilter({
      rules: [{ id: "regex", field: "message", operator: "regex", value: "/^hello/i" }],
    }))).toBe(true);
  });

  it("rejects invalid and nested-repetition regular expressions", () => {
    expect(filterRuleError({
      id: "regex",
      field: "message",
      operator: "regex",
      value: "([",
    })).toBe("Invalid regular expression.");
    expect(filterRuleError({
      id: "regex",
      field: "message",
      operator: "regex",
      value: "(a+)+$",
    })).toContain("Nested repetition");
  });

  it("processes show, hide, and highlight filters in a deterministic pipeline", () => {
    const result = applyMessageFilters(messages, "", [
      makeFilter({
        id: "hide",
        action: "hide",
        rules: [{ id: "a", field: "message", operator: "startsWith", value: "!" }],
      }),
      makeFilter({
        id: "highlight",
        action: "highlight",
        rules: [{ id: "b", field: "role", operator: "equals", value: "moderator" }],
      }),
    ]);
    expect(result.messages.map((message) => message._id)).toEqual(["one"]);
    expect([...result.highlightedIds]).toEqual(["one"]);
  });

  it("ignores corrupt or unsupported persisted filters", () => {
    expect(parseFilterState("not-json")).toEqual({ filters: [], activeIds: [] });
    expect(parseFilterState(JSON.stringify({ version: 99, filters: [] }))).toEqual({
      filters: [],
      activeIds: [],
    });
    expect(parseFilterState(JSON.stringify({
      version: 1,
      filters: [makeFilter({ rules: [] })],
      activeIds: ["filter"],
    }))).toEqual({ filters: [], activeIds: [] });
  });
});

function makeFilter(overrides: Partial<MessageFilter>): MessageFilter {
  return {
    id: "filter",
    name: "Filter",
    action: "show",
    match: "all",
    rules: [{ id: "rule", field: "message", operator: "contains", value: "chat" }],
    ...overrides,
  };
}

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
