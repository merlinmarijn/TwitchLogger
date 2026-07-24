import { describe, expect, it } from "vitest";
import type { Channel } from "../src/api";
import {
  buildSmartSearchFilter,
  buildSmartSearchSuggestions,
  createSmartSearchToken,
} from "../src/smartSearch";

const channels: Channel[] = [{
  _id: "channel",
  platform: "twitch",
  username: "modcentral",
  displayName: "ModCentral",
  loggingEnabled: true,
  connectionStatus: "connected",
}];

describe("smart search", () => {
  it("turns chained tokens into one all/any message filter", () => {
    const filter = buildSmartSearchFilter([
      createSmartSearchToken("sender", "equals", "alice", "User: Alice"),
      createSmartSearchToken("message", "contains", "giveaway", "Message: giveaway"),
    ], "any");

    expect(filter).toMatchObject({
      id: "smart-search",
      action: "show",
      match: "any",
      rules: [
        { field: "sender", operator: "equals", value: "alice" },
        { field: "message", operator: "contains", value: "giveaway" },
      ],
    });
    expect(buildSmartSearchFilter([], "all")).toBeUndefined();
  });

  it("keeps rule identifiers within the server limit for long searches", () => {
    const token = createSmartSearchToken(
      "message",
      "contains",
      "a".repeat(200),
      "Long search",
    );

    expect(token.id.length).toBeLessThanOrEqual(100);
    expect(token.value).toHaveLength(200);
  });

  it("groups text, user, channel, role, and badge interpretations", () => {
    const suggestions = buildSmartSearchSuggestions({
      text: "mod",
      users: [{ username: "mod_viewer", displayName: "Mod Viewer", messageCount: 42 }],
      channels,
    });

    expect(suggestions.map((suggestion) => suggestion.group)).toEqual(
      expect.arrayContaining(["Search", "People", "Channels", "Tags"]),
    );
    expect(suggestions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: "Mod Viewer",
        token: expect.objectContaining({
          field: "sender",
          operator: "equals",
          value: "mod_viewer",
        }),
      }),
      expect.objectContaining({
        title: "Moderator",
        token: expect.objectContaining({ field: "role", value: "moderator" }),
      }),
    ]));
  });
});
