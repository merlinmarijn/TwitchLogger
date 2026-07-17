import { describe, expect, it } from "vitest";
import { buildMessageParts, replaceThirdPartyEmotes } from "../src/emotes";
import {
  parseBetterTtvChannel,
  parseFrankerFaceZ,
} from "../worker/emotes/ThirdPartyEmoteService";

describe("message emotes", () => {
  it("renders Twitch emote fragments with the preferred animated format", () => {
    const parts = buildMessageParts(
      "Hello Kappa",
      [
        { type: "text", text: "Hello " },
        { type: "emote", text: "Kappa", emote: { id: "25", format: ["static", "animated"] } },
      ],
      new Map(),
    );

    expect(parts).toEqual([
      { type: "text", text: "Hello " },
      {
        type: "emote",
        text: "Kappa",
        source: "twitch",
        url: "https://static-cdn.jtvnw.net/emoticons/v2/25/animated/dark/2.0",
      },
    ]);
  });

  it("replaces only whitespace-delimited third-party emote codes", () => {
    const emotes = new Map([
      ["OMEGALUL", { name: "OMEGALUL", url: "https://example.test/emote", source: "bttv" as const }],
    ]);

    expect(replaceThirdPartyEmotes("OMEGALUL OMEGALUL!", emotes)).toEqual([
      { type: "emote", text: "OMEGALUL", url: "https://example.test/emote", source: "bttv" },
      { type: "text", text: " " },
      { type: "text", text: "OMEGALUL!" },
    ]);
  });
});

describe("third-party emote API parsing", () => {
  it("combines BTTV channel and shared emotes", () => {
    expect(parseBetterTtvChannel({
      channelEmotes: [
        { id: "one", code: "ChannelEmote" },
        { id: "effect", code: "z!", modifier: true },
      ],
      sharedEmotes: [{ id: "two", code: "SharedEmote" }],
    })).toEqual([
      { name: "ChannelEmote", source: "bttv", url: "https://cdn.betterttv.net/emote/one/2x" },
      { name: "SharedEmote", source: "bttv", url: "https://cdn.betterttv.net/emote/two/2x" },
    ]);
  });

  it("uses FFZ 2x URLs and ignores hidden emotes", () => {
    expect(parseFrankerFaceZ({
      sets: {
        1: {
          emoticons: [
            { name: "Visible", urls: { 1: "//cdn.test/1", 2: "//cdn.test/2" } },
            { name: "Hidden", hidden: true, urls: { 2: "//cdn.test/hidden" } },
            { name: "Effect", modifier: true, urls: { 2: "//cdn.test/effect" } },
          ],
        },
      },
    })).toEqual([{ name: "Visible", source: "ffz", url: "https://cdn.test/2" }]);
  });
});
