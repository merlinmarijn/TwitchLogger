import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../src/api";
import {
  chatTabAsFilter,
  parseChatTabs,
  serializeChatTabs,
  type ChatViewTab,
} from "../src/chatTabModel";
import { applyMessageFilters } from "../src/filters";
import { tabConditionsKey, tabMatchesMessage } from "../convex/chatTabs";
import { LEGACY_IMAGE_GALLERY_FILTER_PATTERN } from "../shared/imageUrls";

const tab: ChatViewTab = {
  id: "images",
  name: "Images",
  layout: "gallery",
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
    expect(chatTabAsFilter(tab)).toEqual({
      id: tab.id,
      name: tab.name,
      action: "show",
      match: tab.match,
      rules: tab.rules,
    });
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

  it("round-trips a conditionless tab and matches every message", () => {
    const allImages = { ...tab, rules: [] };
    const message = { _id: "anything", messageText: "anything" } as ChatMessage;

    expect(parseChatTabs(serializeChatTabs([allImages]))).toEqual([allImages]);
    expect(tabMatchesMessage(allImages, message)).toBe(true);
  });

  it("loads tabs saved before gallery layouts as chat feeds", () => {
    const legacyTab = {
      id: tab.id,
      name: tab.name,
      match: tab.match,
      rules: tab.rules,
    };
    const raw = JSON.stringify({ version: 1, tabs: [legacyTab] });
    expect(parseChatTabs(raw)).toEqual([{ ...legacyTab, layout: "chat" }]);
  });

  it("uses a tab as an additional show-only feed filter", () => {
    const messages = [
      { _id: "image", messageText: "look https://example.com/photo.png" },
      { _id: "text", messageText: "plain chat message" },
    ] as ChatMessage[];

    expect(applyMessageFilters(messages, "", [chatTabAsFilter(tab)]).messages)
      .toEqual([messages[0]]);
    expect(tabMatchesMessage(tab, messages[0])).toBe(true);
    expect(tabMatchesMessage(tab, messages[1])).toBe(false);
  });

  it("upgrades legacy image gallery rules to match Imgur albums", () => {
    const legacyGallery = {
      ...tab,
      rules: [{ ...tab.rules[0], value: LEGACY_IMAGE_GALLERY_FILTER_PATTERN }],
    };
    const album = { _id: "imgur", messageText: "https://imgur.com/a/I5kYHtp" } as ChatMessage;

    expect(tabMatchesMessage(legacyGallery, album)).toBe(true);
    expect(applyMessageFilters([album], "", [chatTabAsFilter(legacyGallery)]).messages)
      .toEqual([album]);
  });

  it("rebuilds only when matching conditions change", () => {
    const renamedAndRelayouted = { ...tab, name: "Renamed", layout: "chat" as const };
    expect(tabConditionsKey(renamedAndRelayouted)).toBe(tabConditionsKey(tab));
    expect(tabConditionsKey({
      ...tab,
      rules: [{ ...tab.rules[0], value: "\\.webp$" }],
    })).not.toBe(tabConditionsKey(tab));
  });
});
