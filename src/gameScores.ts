import type { ChatMessage } from "./api";

export type GameId = "rngdle" | "foodguessr";
export type ScorePeriod = "day" | "week" | "month" | "all";
export type RngdleRarity =
  | "trash"
  | "common"
  | "uncommon"
  | "rare"
  | "epic"
  | "anomaly"
  | "mythic";

interface BaseGameScore {
  _id: string;
  game: GameId;
  score: number;
  playedAt: number;
  message: ChatMessage;
}

export interface RngdleScore extends BaseGameScore {
  game: "rngdle";
  roll: string;
  rarity: RngdleRarity;
  percentile?: {
    direction: "top" | "bottom";
    value: number;
  };
  traitCount?: number;
}

export interface FoodGuessrScore extends BaseGameScore {
  game: "foodguessr";
  rounds: [number, number, number];
  maxScore: number;
  averageDelta?: number;
}

export type GameScore = RngdleScore | FoodGuessrScore;

export interface LeaderboardEntry {
  rank: number;
  player: string;
  username: string;
  score: number;
  submissions: number;
  best: GameScore;
}

const rngdleRarityPattern =
  /\b(TRASH|COMMON|UNCOMMON|RARE|EPIC|ANOMALY|MYTHIC)\b/i;
const foodDatePattern =
  /\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{4})\b/;

export function parseGameScore(message: ChatMessage): GameScore | undefined {
  return parseRngdleScore(message) ?? parseFoodGuessrScore(message);
}

export function parseGameScores(messages: ChatMessage[]): GameScore[] {
  return dedupeGameScores(messages.flatMap((message) => {
    const parsed = parseGameScore(message);
    return parsed ? [parsed] : [];
  })).sort((left, right) => right.playedAt - left.playedAt);
}

export function parseRngdleScore(message: ChatMessage): RngdleScore | undefined {
  const text = message.messageText;
  const heading = /\bRNGdle\b[\s\S]{0,24}?(\d{1,6})\b/i.exec(text);
  const rarityMatch = rngdleRarityPattern.exec(text);
  const epMatch = /(\d(?:[\d\s.,]*\d)?)\s*EP\b/i.exec(text);
  if (!heading || !rarityMatch || !epMatch) return undefined;

  const score = parseSharedInteger(epMatch[1]);
  if (score === undefined) return undefined;
  const resultText = text.slice(heading.index + heading[0].length);
  const percentileMatch = /\b(Top|Bottom)\s+(\d{1,3})%/i.exec(resultText);
  const moreTraits = /\+(\d+)\s+more\b/i.exec(resultText);

  return {
    _id: message._id,
    game: "rngdle",
    score,
    playedAt: message.timestamp,
    message,
    roll: heading[1],
    rarity: rarityMatch[1].toLowerCase() as RngdleRarity,
    ...(percentileMatch ? {
      percentile: {
        direction: percentileMatch[1].toLowerCase() as "top" | "bottom",
        value: Number(percentileMatch[2]),
      },
    } : {}),
    ...(moreTraits ? { traitCount: Number(moreTraits[1]) + 3 } : {}),
  };
}

export function parseFoodGuessrScore(
  message: ChatMessage,
): FoodGuessrScore | undefined {
  const text = message.messageText;
  if (!/\bFoodGuessr\b/i.test(text)) return undefined;

  const compactShare = /\bI got\s+(\d(?:[\d\s.,]*\d)?)\s+on the FoodGuessr Daily\b/i.exec(text);
  const detailedShare = /\bTotal score:\s*(\d(?:[\d\s.,]*\d)?)\s*\/\s*(\d(?:[\d\s.,]*\d)?)/i.exec(text);
  const score = parseSharedInteger(compactShare?.[1] ?? detailedShare?.[1]);
  if (score === undefined) return undefined;

  const rounds = [1, 2, 3].map((round) => parseFoodRound(text, round));
  if (rounds.some((round) => round === undefined)) return undefined;
  const maxScore = parseSharedInteger(detailedShare?.[2]) ?? 15_000;
  const playedAt = parseFoodDate(text) ?? message.timestamp;
  const averageDelta = parseAverageDelta(text);

  return {
    _id: message._id,
    game: "foodguessr",
    score,
    playedAt,
    message,
    rounds: rounds as [number, number, number],
    maxScore,
    ...(averageDelta === undefined ? {} : { averageDelta }),
  };
}

export function dedupeGameScores(scores: GameScore[]): GameScore[] {
  const unique = new Map<string, GameScore>();
  for (const score of scores) {
    const username = score.message.senderUsername.toLowerCase();
    const attempt = score.game === "rngdle"
      ? `${score.roll}:${score.score}`
      : utcDateKey(score.playedAt);
    const key = `${score.game}:${username}:${attempt}`;
    const existing = unique.get(key);
    if (!existing || score.score > existing.score ||
        (score.score === existing.score && score.message.timestamp < existing.message.timestamp)) {
      unique.set(key, score);
    }
  }
  return [...unique.values()];
}

export function buildLeaderboard(
  scores: GameScore[],
  game: GameId,
  period: ScorePeriod,
  now = Date.now(),
): LeaderboardEntry[] {
  const start = scorePeriodStart(period, now);
  const byPlayer = new Map<string, { best: GameScore; submissions: number }>();
  for (const score of dedupeGameScores(scores)) {
    if (score.game !== game || score.playedAt < start || score.playedAt > now) continue;
    const username = score.message.senderUsername.toLowerCase();
    const current = byPlayer.get(username);
    if (!current) {
      byPlayer.set(username, { best: score, submissions: 1 });
      continue;
    }
    current.submissions += 1;
    if (score.score > current.best.score ||
        (score.score === current.best.score && score.playedAt < current.best.playedAt)) {
      current.best = score;
    }
  }

  const ranked = [...byPlayer.entries()].sort(([, left], [, right]) =>
    right.best.score - left.best.score ||
    left.best.playedAt - right.best.playedAt ||
    left.best.message.senderDisplayName.localeCompare(right.best.message.senderDisplayName),
  );
  let previousScore: number | undefined;
  let rank = 0;
  return ranked.map(([username, entry], index) => {
    if (entry.best.score !== previousScore) rank = index + 1;
    previousScore = entry.best.score;
    return {
      rank,
      player: entry.best.message.senderDisplayName,
      username,
      score: entry.best.score,
      submissions: entry.submissions,
      best: entry.best,
    };
  });
}

export function scorePeriodStart(period: ScorePeriod, now = Date.now()): number {
  if (period === "all") return Number.NEGATIVE_INFINITY;
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  if (period === "week") {
    const daysSinceMonday = (date.getDay() + 6) % 7;
    date.setDate(date.getDate() - daysSinceMonday);
  } else if (period === "month") {
    date.setDate(1);
  }
  return date.getTime();
}

function parseSharedInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const digits = value.replace(/\D/g, "");
  if (!digits) return undefined;
  const parsed = Number(digits);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseFoodRound(text: string, round: number): number | undefined {
  const pattern = new RegExp(
    String.raw`(\d(?:[\d\s.,]*\d)?)\s*(?:[·⋅]\s*)?\(?Round\s*${round}\)?`,
    "i",
  );
  return parseSharedInteger(pattern.exec(text)?.[1]);
}

function parseFoodDate(text: string): number | undefined {
  const match = foodDatePattern.exec(text);
  if (!match) return undefined;
  const parsed = Date.parse(`${match[1]} ${match[2]}, ${match[3]} 00:00:00 UTC`);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function parseAverageDelta(text: string): number | undefined {
  const parenthesized = /\(([+-])\s*(\d(?:[\d\s.,]*\d)?)\s+(above|below)\b/i.exec(text);
  if (parenthesized) {
    const value = parseSharedInteger(parenthesized[2]);
    if (value === undefined) return undefined;
    return parenthesized[1] === "-" || parenthesized[3].toLowerCase() === "below"
      ? -value
      : value;
  }
  const sentence = /(\d(?:[\d\s.,]*\d)?)\s+points?\s+(above|below)\b/i.exec(text);
  const value = parseSharedInteger(sentence?.[1]);
  if (value === undefined || !sentence) return undefined;
  return sentence[2].toLowerCase() === "below" ? -value : value;
}

function utcDateKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}-${date.getUTCDate()}`;
}
