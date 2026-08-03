import { describe, expect, it } from "vitest";
import type { Channel } from "../src/api";
import {
  buildSmartSearchFilter,
  buildSmartSearchSuggestions,
  createSmartSearchToken,
  isSmartSearchPending,
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
  it("does not report a pending search while a guided filter value is being typed", () => {
    expect(isSmartSearchPending({
      draft: "toofisn",
      editingFilterValue: true,
      searching: true,
      value: "",
    })).toBe(false);
    expect(isSmartSearchPending({
      draft: "giveaway",
      editingFilterValue: false,
      searching: false,
      value: "",
    })).toBe(true);
  });

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
        title: "Message: “mod”",
        excludeToken: expect.objectContaining({
          field: "message",
          operator: "notContains",
          value: "mod",
        }),
      }),
      expect.objectContaining({
        title: "Sender contains “mod”",
        excludeToken: expect.objectContaining({
          field: "sender",
          operator: "notContains",
          value: "mod",
        }),
      }),
      expect.objectContaining({
        title: "Mod Viewer",
        token: expect.objectContaining({
          field: "sender",
          operator: "equals",
          value: "mod_viewer",
        }),
      }),
      expect.objectContaining({
        title: "Mod Viewer",
        excludeToken: expect.objectContaining({
          field: "sender",
          operator: "notEquals",
          value: "mod_viewer",
        }),
      }),
      expect.objectContaining({
        title: "Moderator",
        token: expect.objectContaining({ field: "role", value: "moderator" }),
      }),
      expect.objectContaining({
        title: "Moderator",
        excludeToken: expect.objectContaining({
          field: "role",
          operator: "notEquals",
          value: "moderator",
        }),
      }),
      expect.objectContaining({
        title: "ModCentral",
        excludeToken: expect.objectContaining({
          field: "channel",
          operator: "notEquals",
          value: "ModCentral",
        }),
      }),
      expect.objectContaining({
        title: "Moderator badge",
        excludeToken: expect.objectContaining({
          field: "badge",
          operator: "notHas",
          value: "moderator",
        }),
      }),
    ]));
  });

  it("offers positive and negative image-link interpretations", () => {
    const suggestions = buildSmartSearchSuggestions({
      text: "image",
      users: [],
      channels: [],
    });

    expect(suggestions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: "Messages with image links",
        token: expect.objectContaining({ field: "image", operator: "has" }),
      }),
      expect.objectContaining({
        title: "Messages with image links",
        excludeToken: expect.objectContaining({ field: "image", operator: "notHas" }),
      }),
    ]));
    expect(suggestions).toHaveLength(4);
  });

  it("offers positive and negative any-link interpretations", () => {
    const suggestions = buildSmartSearchSuggestions({
      text: "link",
      users: [],
      channels: [],
    });

    expect(suggestions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: "Messages with links",
        token: expect.objectContaining({ field: "link", operator: "has" }),
        excludeToken: expect.objectContaining({ field: "link", operator: "notHas" }),
      }),
    ]));
  });
});
