import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../src/api";
import {
  chatTabAsFilter,
  parseChatTabs,
  serializeChatTabs,
  type ChatViewTab,
} from "../src/chatTabModel";
import { applyMessageFilters } from "../src/filters";
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
    expect(applyMessageFilters([message], "", [chatTabAsFilter(allImages)]).messages)
      .toEqual([message]);
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

  it("round-trips game score room tabs", () => {
    const scoresTab: ChatViewTab = {
      id: "scores",
      name: "High scores",
      layout: "scores",
      match: "any",
      rules: [],
    };
    expect(parseChatTabs(serializeChatTabs([scoresTab]))).toEqual([scoresTab]);
    expect(chatTabAsFilter(scoresTab).rules).toEqual([]);
  });

  it("uses a tab as an additional show-only feed filter", () => {
    const messages = [
      { _id: "image", messageText: "look https://example.com/photo.png" },
      { _id: "text", messageText: "plain chat message" },
    ] as ChatMessage[];

    expect(applyMessageFilters(messages, "", [chatTabAsFilter(tab)]).messages)
      .toEqual([messages[0]]);
  });

  it("upgrades legacy image gallery rules to match Imgur albums", () => {
    const legacyGallery = {
      ...tab,
      rules: [{ ...tab.rules[0], value: LEGACY_IMAGE_GALLERY_FILTER_PATTERN }],
    };
    const album = { _id: "imgur", messageText: "https://imgur.com/a/I5kYHtp" } as ChatMessage;

    expect(applyMessageFilters([album], "", [chatTabAsFilter(legacyGallery)]).messages)
      .toEqual([album]);
  });

  it("upgrades legacy image gallery rules to match Bluesky CDN images", () => {
    const legacyGallery = {
      ...tab,
      rules: [{ ...tab.rules[0], value: LEGACY_IMAGE_GALLERY_FILTER_PATTERN }],
    };
    const image = {
      _id: "bluesky",
      messageText: "https://cdn.bsky.app/img/feed_thumbnail/plain/did:plc:23reh4wn7sc7wtcurl575tox/bafkreiefmuwe3ky6csho2szr4wsbllknenc6fl3pbaemwy3uyc2re7u5ma",
    } as ChatMessage;

    expect(applyMessageFilters([image], "", [chatTabAsFilter(legacyGallery)]).messages)
      .toEqual([image]);
  });
});
