import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../src/api";
import {
  chatTabAsFilter,
  parseChatTabs,
  serializeChatTabs,
  type ChatViewTab,
} from "../src/chatTabModel";
import { applyMessageFilters } from "../src/filters";

const tab: ChatViewTab = {
  id: "images",
  name: "Images",
  match: "any",
  rules: [{
    id: "image-rule",
    field: "message",
    operator: "regex",
    value: "\\.png$",
  }],
};

describe("chat tabs", () => {
  it("round-trips valid tabs and converts them into show filters", () => {
    expect(parseChatTabs(serializeChatTabs([tab]))).toEqual([tab]);
    expect(chatTabAsFilter(tab)).toEqual({ ...tab, action: "show" });
  });

  it("drops malformed, duplicate, and invalid-regex tabs", () => {
    const raw = JSON.stringify({
      version: 1,
      tabs: [
        tab,
        tab,
        { ...tab, id: "bad", rules: [{ ...tab.rules[0], value: "([" }] },
        { name: "Missing fields" },
      ],
    });
    expect(parseChatTabs(raw)).toEqual([tab]);
    expect(parseChatTabs("not-json")).toEqual([]);
  });

  it("uses a tab as an additional show-only feed filter", () => {
    const messages = [
      { _id: "image", messageText: "look https://example.com/photo.png" },
      { _id: "text", messageText: "plain chat message" },
    ] as ChatMessage[];

    expect(applyMessageFilters(messages, "", [chatTabAsFilter(tab)]).messages)
      .toEqual([messages[0]]);
  });
});
