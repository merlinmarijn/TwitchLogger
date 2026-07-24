import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../src/api";
import {
  buildLeaderboard,
  parseFoodGuessrScore,
  parseGameScores,
  parseRngdleScore,
  scorePeriodStart,
} from "../src/gameScores";

describe("game score parsers", () => {
  it("parses RNGdle shares with prefixes, percentile, rarity, traits, and comma EP", () => {
    const score = parseRngdleScore(message(
      "rng-1",
      "Houdini111",
      "I got bottom 5% gladi RNGdle 🎲 551764 ⬜ COMMON • Bottom 9% ⬜ ↕️ Gap One ⬜ 💧 Hydrogen (1) ⬜ ✏️ Carbon (6) +10 more 2,958 EP https://rngdle.com",
    ));

    expect(score).toMatchObject({
      game: "rngdle",
      roll: "551764",
      rarity: "common",
      score: 2958,
      percentile: { direction: "bottom", value: 9 },
      traitCount: 13,
    });
  });

  it("normalizes dot and space thousands separators in RNGdle shares", () => {
    expect(parseRngdleScore(message(
      "rng-dot",
      "TheLagSlave",
      "RNGdle 🎲 159703 ⬜ COMMON +8 more 3.086 EP https://rngdle.com",
    ))?.score).toBe(3086);
    expect(parseRngdleScore(message(
      "rng-space",
      "yukino_014",
      "RNGdle 🎲 424268 🟥 MYTHIC • Top 0% +13 more 346 410 EP https://rngdle.com/",
    ))?.score).toBe(346410);
  });

  it("parses the detailed FoodGuessr share format", () => {
    const score = parseFoodGuessrScore(message(
      "food-detailed",
      "Bloodhit",
      "FoodGuessr - Saturday, Jul 18, 2026 UTC 🌕🌕🌕🌕🌕 5 000 ⋅ Round 1 💯 🌕🌕🌕🌕🌑 4 000 ⋅ Round 2 🌕🌑🌑🌑🌑 758 ⋅ Round 3 Total score: 9 758/15 000 (+135 above today's average!) 🎉",
    ));

    expect(score).toMatchObject({
      game: "foodguessr",
      score: 9758,
      maxScore: 15000,
      rounds: [5000, 4000, 758],
      averageDelta: 135,
    });
    expect(new Date(score!.playedAt).toISOString()).toBe("2026-07-18T00:00:00.000Z");
  });

  it("parses comma and European-dot FoodGuessr Daily shares", () => {
    const comma = parseFoodGuessrScore(message(
      "food-comma",
      "Toonfish",
      "I got 15,000 on the FoodGuessr Daily! That's 3,371 points above today's average! 🎉 🌕🌕🌕🌕🌕 5,000 (Round 1) 💯 🌕🌕🌕🌕🌕 5,000 (Round 2) 💯 🌕🌕🌕🌕🌕 5,000 (Round 3) 💯 Tuesday, Jul 21, 2026",
    ));
    const dot = parseFoodGuessrScore(message(
      "food-dot",
      "Cyeena",
      "I got 13.000 on the FoodGuessr Daily! That's 1.372 points above today's average! 🎉 🌕🌕🌕🌕🌗 4.500 (Round 1) 🌕🌕🌕🌕🌗 4.500 (Round 2) 🌕🌕🌕🌕🌑 4.000 (Round 3) Tuesday, Jul 21, 2026",
    ));

    expect(comma).toMatchObject({ score: 15000, rounds: [5000, 5000, 5000], averageDelta: 3371 });
    expect(dot).toMatchObject({ score: 13000, rounds: [4500, 4500, 4000], averageDelta: 1372 });
  });

  it("rejects ordinary mentions of either game", () => {
    expect(parseRngdleScore(message("chat-1", "viewer", "RNGdle was fun today"))).toBeUndefined();
    expect(parseFoodGuessrScore(message("chat-2", "viewer", "let's play FoodGuessr"))).toBeUndefined();
  });
});

describe("game score rankings", () => {
  it("deduplicates reposts and keeps each player's best score", () => {
    const now = new Date(2026, 6, 24, 12).getTime();
    const scores = parseGameScores([
      message("one", "alice", "RNGdle 🎲 123456 🟧 ANOMALY • Top 3% +10 more 50,000 EP https://rngdle.com", now - 1000),
      message("repost", "alice", "wow RNGdle 🎲 123456 🟧 ANOMALY • Top 3% +10 more 50,000 EP https://rngdle.com", now),
      message("better", "alice", "RNGdle 🎲 654321 🟥 MYTHIC • Top 0% +14 more 90,000 EP https://rngdle.com", now),
      message("bob", "bob", "RNGdle 🎲 111222 🟪 EPIC • Top 5% +8 more 75,000 EP https://rngdle.com", now),
    ]);
    const board = buildLeaderboard(scores, "rngdle", "all", now + 1);

    expect(scores).toHaveLength(3);
    expect(board.map(({ player, score, submissions }) => ({ player, score, submissions }))).toEqual([
      { player: "alice", score: 90000, submissions: 2 },
      { player: "bob", score: 75000, submissions: 1 },
    ]);
  });

  it("uses Monday, month, and day boundaries for leaderboard periods", () => {
    const now = new Date(2026, 6, 24, 12).getTime();
    expect(new Date(scorePeriodStart("day", now)).getDay()).toBe(5);
    expect(new Date(scorePeriodStart("week", now)).getDay()).toBe(1);
    expect(new Date(scorePeriodStart("month", now)).getDate()).toBe(1);
    expect(scorePeriodStart("all", now)).toBe(Number.NEGATIVE_INFINITY);
  });
});

function message(
  id: string,
  username: string,
  messageText: string,
  timestamp = Date.UTC(2026, 6, 24, 12),
): ChatMessage {
  return {
    _id: id,
    externalChannelId: "channel",
    channelName: "cirno_tv",
    senderUsername: username,
    senderDisplayName: username,
    messageText,
    timestamp,
    badges: [],
    isBroadcaster: false,
    isModerator: false,
    isSubscriber: false,
    isVip: false,
    messageType: "text",
  };
}
