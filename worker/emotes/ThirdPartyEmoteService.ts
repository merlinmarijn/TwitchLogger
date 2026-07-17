import type { Logger } from "../logger";

export type ThirdPartyEmoteSource = "bttv" | "ffz";

export interface ThirdPartyEmote {
  name: string;
  url: string;
  source: ThirdPartyEmoteSource;
}

interface BetterTtvEmote {
  id?: unknown;
  code?: unknown;
  modifier?: unknown;
}

interface FrankerFaceZEmote {
  name?: unknown;
  urls?: Record<string, unknown>;
  hidden?: unknown;
  modifier?: unknown;
}

interface CachedCatalog {
  expiresAt: number;
  emotes: ThirdPartyEmote[];
}

interface CachedJson {
  expiresAt: number;
  value: unknown;
}

type Fetcher = typeof fetch;

const CACHE_TTL_MS = 15 * 60 * 1000;
const BETTER_TTV_API = "https://api.betterttv.net/3/cached";
const FRANKER_FACE_Z_API = "https://api.frankerfacez.com/v1";

export class ThirdPartyEmoteService {
  private readonly catalogs = new Map<string, CachedCatalog>();
  private readonly pending = new Map<string, Promise<ThirdPartyEmote[]>>();
  private readonly jsonResponses = new Map<string, CachedJson>();
  private readonly jsonPending = new Map<string, Promise<unknown>>();

  constructor(
    private readonly logger: Logger,
    private readonly fetcher: Fetcher = fetch,
    private readonly cacheTtlMs = CACHE_TTL_MS,
  ) {}

  async getCatalog(twitchChannelId: string): Promise<ThirdPartyEmote[]> {
    const cached = this.catalogs.get(twitchChannelId);
    if (cached && cached.expiresAt > Date.now()) return cached.emotes;

    const existing = this.pending.get(twitchChannelId);
    if (existing) return existing;

    const request = this.loadCatalog(twitchChannelId).finally(() => {
      this.pending.delete(twitchChannelId);
    });
    this.pending.set(twitchChannelId, request);
    return request;
  }

  private async loadCatalog(twitchChannelId: string): Promise<ThirdPartyEmote[]> {
    const requests = await Promise.all([
      this.fetchJson(`${BETTER_TTV_API}/emotes/global`),
      this.fetchJson(`${FRANKER_FACE_Z_API}/set/global`),
      this.fetchJson(`${BETTER_TTV_API}/users/twitch/${twitchChannelId}`),
      this.fetchJson(`${FRANKER_FACE_Z_API}/room/id/${twitchChannelId}`),
    ]);

    const catalog = new Map<string, ThirdPartyEmote>();
    for (const emote of parseBetterTtvGlobal(requests[0])) catalog.set(emote.name, emote);
    for (const emote of parseFrankerFaceZ(requests[1])) catalog.set(emote.name, emote);
    for (const emote of parseBetterTtvChannel(requests[2])) catalog.set(emote.name, emote);
    for (const emote of parseFrankerFaceZ(requests[3])) catalog.set(emote.name, emote);

    const emotes = [...catalog.values()];
    this.catalogs.set(twitchChannelId, {
      expiresAt: Date.now() + this.cacheTtlMs,
      emotes,
    });
    return emotes;
  }

  private async fetchJson(url: string): Promise<unknown> {
    const cached = this.jsonResponses.get(url);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const existing = this.jsonPending.get(url);
    if (existing) return existing;

    const request = this.loadJson(url, cached?.value).finally(() => {
      this.jsonPending.delete(url);
    });
    this.jsonPending.set(url, request);
    return request;
  }

  private async loadJson(url: string, staleValue: unknown): Promise<unknown> {
    try {
      const response = await this.fetcher(url, {
        headers: { Accept: "application/json", "User-Agent": "TwitchLogs/0.1" },
        signal: AbortSignal.timeout(5_000),
      });
      if (response.status === 404) {
        this.jsonResponses.set(url, {
          expiresAt: Date.now() + this.cacheTtlMs,
          value: undefined,
        });
        return undefined;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const value: unknown = await response.json();
      this.jsonResponses.set(url, {
        expiresAt: Date.now() + this.cacheTtlMs,
        value,
      });
      return value;
    } catch (error) {
      this.logger.warn({ err: error, url }, "Could not load third-party emotes");
      return staleValue;
    }
  }
}

export function parseBetterTtvGlobal(value: unknown): ThirdPartyEmote[] {
  return parseBetterTtvEmotes(Array.isArray(value) ? value : []);
}

export function parseBetterTtvChannel(value: unknown): ThirdPartyEmote[] {
  if (!isRecord(value)) return [];
  const channelEmotes = Array.isArray(value.channelEmotes) ? value.channelEmotes : [];
  const sharedEmotes = Array.isArray(value.sharedEmotes) ? value.sharedEmotes : [];
  return parseBetterTtvEmotes([...channelEmotes, ...sharedEmotes]);
}

function parseBetterTtvEmotes(value: unknown[]): ThirdPartyEmote[] {
  return value.flatMap((candidate) => {
    const emote = candidate as BetterTtvEmote;
    if (
      emote.modifier === true ||
      typeof emote.id !== "string" ||
      typeof emote.code !== "string"
    ) return [];
    return [{
      name: emote.code,
      url: `https://cdn.betterttv.net/emote/${encodeURIComponent(emote.id)}/2x`,
      source: "bttv" as const,
    }];
  });
}

export function parseFrankerFaceZ(value: unknown): ThirdPartyEmote[] {
  if (!isRecord(value) || !isRecord(value.sets)) return [];
  const emotes: ThirdPartyEmote[] = [];
  for (const set of Object.values(value.sets)) {
    if (!isRecord(set) || !Array.isArray(set.emoticons)) continue;
    for (const candidate of set.emoticons) {
      const emote = candidate as FrankerFaceZEmote;
      if (
        emote.hidden === true ||
        emote.modifier === true ||
        typeof emote.name !== "string" ||
        !isRecord(emote.urls)
      ) {
        continue;
      }
      const url = emote.urls["2"] ?? emote.urls["1"];
      if (typeof url !== "string") continue;
      emotes.push({
        name: emote.name,
        url: url.startsWith("//") ? `https:${url}` : url,
        source: "ffz",
      });
    }
  }
  return emotes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
