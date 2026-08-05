import { describe, expect, it } from "vitest";
import { buildMessageParts, replaceThirdPartyEmotes } from "../src/emotes";
import {
  parseBetterTtvChannel,
  parseFrankerFaceZ,
  parseSevenTv,
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
  it("combines BTTV channel emotes and honors shared-emote code aliases", () => {
    expect(parseBetterTtvChannel({
      channelEmotes: [
        { id: "one", code: "ChannelEmote" },
        { id: "effect", code: "z!", modifier: true },
      ],
      sharedEmotes: [{ id: "two", code: "SharedAlias", name: "OriginalName" }],
    })).toEqual([
      { name: "ChannelEmote", source: "bttv", url: "https://cdn.betterttv.net/emote/one/2x" },
      { name: "SharedAlias", source: "bttv", url: "https://cdn.betterttv.net/emote/two/2x" },
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

  it("uses 7TV aliases and prefers animated-capable 2x WebP files", () => {
    expect(parseSevenTv({
      emote_set: {
        emotes: [
          {
            name: "ChannelAlias",
            data: {
              name: "OriginalName",
              host: {
                url: "//cdn.7tv.app/emote/one",
                files: [{ name: "1x.webp" }, { name: "2x.webp" }],
              },
            },
          },
          { name: "Unavailable", data: null },
        ],
      },
    })).toEqual([{
      name: "ChannelAlias",
      source: "7tv",
      url: "https://cdn.7tv.app/emote/one/2x.webp",
    }]);
  });

  it("parses the root emote set used by the 7TV global endpoint", () => {
    expect(parseSevenTv({
      emotes: [{
        name: "GlobalSevenTv",
        data: {
          host: {
            url: "https://cdn.7tv.app/emote/two/",
            files: [{ name: "1x.avif" }],
          },
        },
      }],
    })).toEqual([{
      name: "GlobalSevenTv",
      source: "7tv",
      url: "https://cdn.7tv.app/emote/two/1x.avif",
    }]);
  });
});
