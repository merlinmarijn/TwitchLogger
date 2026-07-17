import type { Logger } from "../logger";
import {
  TwitchApiError,
  type TwitchChatBadgeDefinition,
  type TwitchUser,
} from "../types";
import type { TwitchAuthService } from "./TwitchAuthService";

interface HelixResponse<T> {
  data: T[];
}

interface HelixUser {
  id: string;
  login: string;
  display_name: string;
}

interface EventSubSubscription {
  id: string;
  status: string;
}

interface HelixChatBadgeSet {
  set_id: string;
  versions: Array<{
    id: string;
    image_url_2x: string;
    title: string;
    description: string;
  }>;
}

export class TwitchApiClient {
  constructor(
    private readonly clientId: string,
    private readonly auth: TwitchAuthService,
    private readonly logger: Logger,
  ) {}

  async resolveUser(login: string, signal?: AbortSignal): Promise<TwitchUser | null> {
    const normalized = login.trim().toLowerCase().replace(/^@/, "");
    const response = await this.request<HelixResponse<HelixUser>>(
      `/users?login=${encodeURIComponent(normalized)}`,
      { signal },
    );
    const user = response.data[0];
    return user
      ? { id: user.id, login: user.login, displayName: user.display_name }
      : null;
  }

  async createChatSubscription(
    broadcasterUserId: string,
    chattingUserId: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const response = await this.request<HelixResponse<EventSubSubscription>>(
      "/eventsub/subscriptions",
      {
        method: "POST",
        signal,
        body: JSON.stringify({
          type: "channel.chat.message",
          version: "1",
          condition: {
            broadcaster_user_id: broadcasterUserId,
            user_id: chattingUserId,
          },
          transport: { method: "websocket", session_id: sessionId },
        }),
      },
    );
    const subscription = response.data[0];
    if (!subscription) throw new TwitchApiError("Twitch returned no subscription", 502);
    this.logger.info(
      { subscriptionId: subscription.id, broadcasterUserId, status: subscription.status },
      "Twitch chat subscription created",
    );
    return subscription.id;
  }

  async deleteSubscription(subscriptionId: string, signal?: AbortSignal): Promise<void> {
    await this.request<void>(
      `/eventsub/subscriptions?id=${encodeURIComponent(subscriptionId)}`,
      { method: "DELETE", signal },
    );
    this.logger.info({ subscriptionId }, "Twitch chat subscription removed");
  }

  async getGlobalChatBadges(signal?: AbortSignal): Promise<TwitchChatBadgeDefinition[]> {
    const response = await this.request<HelixResponse<HelixChatBadgeSet>>(
      "/chat/badges/global",
      { signal },
    );
    return flattenChatBadges(response.data);
  }

  async getChannelChatBadges(
    broadcasterUserId: string,
    signal?: AbortSignal,
  ): Promise<TwitchChatBadgeDefinition[]> {
    const response = await this.request<HelixResponse<HelixChatBadgeSet>>(
      `/chat/badges?broadcaster_id=${encodeURIComponent(broadcasterUserId)}`,
      { signal },
    );
    return flattenChatBadges(response.data);
  }

  private async request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
    const accessToken = await this.auth.getAccessToken();
    const response = await fetch(`https://api.twitch.tv/helix${path}`, {
      ...init,
      headers: {
        "Client-Id": this.clientId,
        Authorization: `Bearer ${accessToken}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });

    if (response.status === 401 && retry) {
      this.logger.warn({ path }, "Twitch API rejected the access token; refreshing once");
      await this.auth.refreshAccessToken();
      return this.request<T>(path, init, false);
    }

    if (!response.ok) {
      const body = await response.json().catch(() => undefined);
      throw new TwitchApiError(
        `Twitch API request failed (${response.status})`,
        response.status,
        body,
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}

function flattenChatBadges(sets: HelixChatBadgeSet[]): TwitchChatBadgeDefinition[] {
  return sets.flatMap((set) =>
    set.versions.map((version) => ({
      setId: set.set_id,
      id: version.id,
      imageUrl: version.image_url_2x,
      title: version.title,
      description: version.description,
    })),
  );
}
