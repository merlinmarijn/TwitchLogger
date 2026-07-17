import type { Logger } from "../logger";
import type { TwitchChatBadgeDefinition } from "../types";
import type { TwitchApiClient } from "./TwitchApiClient";

interface CachedBadges {
  expiresAt: number;
  badges: TwitchChatBadgeDefinition[];
}

type BadgeApi = Pick<
  TwitchApiClient,
  "getGlobalChatBadges" | "getChannelChatBadges"
>;

const CACHE_TTL_MS = 15 * 60 * 1000;

export class TwitchBadgeService {
  private global?: CachedBadges;
  private globalPending?: Promise<TwitchChatBadgeDefinition[]>;
  private readonly channels = new Map<string, CachedBadges>();
  private readonly channelPending = new Map<
    string,
    Promise<TwitchChatBadgeDefinition[]>
  >();

  constructor(
    private readonly api: BadgeApi,
    private readonly logger: Logger,
    private readonly cacheTtlMs = CACHE_TTL_MS,
  ) {}

  async getCatalog(twitchChannelId: string): Promise<TwitchChatBadgeDefinition[]> {
    const [global, channel] = await Promise.all([
      this.getGlobalBadges(),
      this.getChannelBadges(twitchChannelId),
    ]);
    const catalog = new Map<string, TwitchChatBadgeDefinition>();
    for (const badge of global) catalog.set(badgeKey(badge), badge);
    for (const badge of channel) catalog.set(badgeKey(badge), badge);
    return [...catalog.values()];
  }

  private async getGlobalBadges(): Promise<TwitchChatBadgeDefinition[]> {
    if (this.global && this.global.expiresAt > Date.now()) return this.global.badges;
    if (this.globalPending) return this.globalPending;
    const stale = this.global?.badges;
    this.globalPending = this.api
      .getGlobalChatBadges()
      .then((badges) => {
        this.global = { expiresAt: Date.now() + this.cacheTtlMs, badges };
        return badges;
      })
      .catch((error: unknown) => this.useStaleOrThrow(error, stale, "global"))
      .finally(() => {
        this.globalPending = undefined;
      });
    return this.globalPending;
  }

  private async getChannelBadges(
    twitchChannelId: string,
  ): Promise<TwitchChatBadgeDefinition[]> {
    const cached = this.channels.get(twitchChannelId);
    if (cached && cached.expiresAt > Date.now()) return cached.badges;
    const existing = this.channelPending.get(twitchChannelId);
    if (existing) return existing;

    const request = this.api
      .getChannelChatBadges(twitchChannelId)
      .then((badges) => {
        this.channels.set(twitchChannelId, {
          expiresAt: Date.now() + this.cacheTtlMs,
          badges,
        });
        return badges;
      })
      .catch((error: unknown) =>
        this.useStaleOrThrow(error, cached?.badges, twitchChannelId),
      )
      .finally(() => {
        this.channelPending.delete(twitchChannelId);
      });
    this.channelPending.set(twitchChannelId, request);
    return request;
  }

  private useStaleOrThrow(
    error: unknown,
    stale: TwitchChatBadgeDefinition[] | undefined,
    scope: string,
  ) {
    this.logger.warn({ err: error, scope }, "Could not refresh Twitch chat badges");
    if (stale) return stale;
    throw error;
  }
}

export function badgeKey(badge: Pick<TwitchChatBadgeDefinition, "setId" | "id">) {
  return `${badge.setId}/${badge.id}`;
}
