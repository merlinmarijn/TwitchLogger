import type { Logger } from "../logger";
import type {
  FollowedChannel,
  ResolvedChannel,
  TwitchAuthorization,
  TwitchChatMessage,
} from "../types";
import type { ChatRepository } from "../ChatRepository";
import type { TwitchApiClient } from "./TwitchApiClient";
import type { TwitchAuthService } from "./TwitchAuthService";
import type {
  TwitchChatNotification,
  TwitchEventSubClient,
} from "./TwitchEventSubClient";
import { normalizeChatMessage } from "./normalizeChatMessage";

export type TwitchChatMessageListener = (message: TwitchChatMessage) => void;

export class TwitchChatService {
  private readonly listeners = new Set<TwitchChatMessageListener>();
  private channelsByTwitchId = new Map<string, ResolvedChannel>();
  private syncQueue = Promise.resolve();
  private unsubscribeChannels?: () => void;
  private eventSubRunning = false;
  private signal?: AbortSignal;
  private latestChannels: FollowedChannel[] = [];

  constructor(
    private readonly auth: TwitchAuthService,
    private readonly api: TwitchApiClient,
    private readonly eventSub: TwitchEventSubClient,
    private readonly repository: ChatRepository,
    private readonly logger: Logger,
  ) {
    this.eventSub.onNotification((notification) => {
      void this.handleNotification(notification);
    });
    this.eventSub.onStatus((status, error) => {
      void this.handleConnectionStatus(status, error);
    });
    this.auth.onAuthorizationChanged((authorization) => {
      void this.handleAuthorizationChanged(authorization);
    });
  }

  onMessage(listener: TwitchChatMessageListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(signal: AbortSignal) {
    this.signal = signal;
    await this.auth.initialize(signal);
    this.unsubscribeChannels = this.repository.watchLoggingChannels(
      (channels) => {
        this.syncQueue = this.syncQueue
          .then(() => this.synchronizeChannels(channels))
          .catch((error) => this.logger.error({ err: error }, "Channel synchronization failed"));
      },
      (error) => this.logger.error({ err: error }, "PostgreSQL channel polling failed"),
    );
    signal.addEventListener("abort", () => this.stop(), { once: true });
  }

  stop() {
    this.pause();
    this.repository.close();
  }

  pause() {
    this.unsubscribeChannels?.();
    this.unsubscribeChannels = undefined;
    this.eventSub.stop();
    this.eventSubRunning = false;
  }

  private async synchronizeChannels(channels: FollowedChannel[]) {
    this.latestChannels = channels;
    const resolved: ResolvedChannel[] = [];
    for (const channel of channels) {
      if (this.signal?.aborted) return;
      try {
        let twitchId = channel.externalChannelId;
        let username = channel.username;
        let displayName = channel.displayName;
        if (!twitchId) {
          const user = await this.api.resolveUser(channel.username, this.signal);
          if (!user) {
            await this.repository.setConnectionStatus(
              channel._id,
              "error",
              "Twitch channel not found",
            );
            continue;
          }
          twitchId = user.id;
          username = user.login;
          displayName = user.displayName;
          await this.repository.saveResolvedChannel({
            storageId: channel._id,
            twitchId,
            username,
            displayName,
          });
          this.logger.info(
            { channel: username, broadcasterUserId: twitchId },
            "Resolved Twitch channel",
          );
        }
        resolved.push({
          storageId: channel._id,
          twitchId,
          username,
          displayName,
        });
      } catch (error) {
        this.logger.error({ err: error, channel: channel.username }, "Channel resolution failed");
        const authorizationRequired = !this.auth.getStatus().authenticated;
        await this.repository.setConnectionStatus(
          channel._id,
          authorizationRequired ? "authorization_required" : "error",
          authorizationRequired ? "Connect Twitch to start logging" : "Channel setup failed",
        );
      }
    }

    this.channelsByTwitchId = new Map(resolved.map((channel) => [channel.twitchId, channel]));
    await this.eventSub.setChannels(resolved);
    await this.ensureEventSubState();
    if (this.eventSubRunning) {
      await Promise.all(
        resolved.map((channel) =>
          this.repository.setConnectionStatus(channel.storageId, "connected"),
        ),
      );
    }
  }

  private async ensureEventSubState() {
    const authorization = this.auth.getStatus();
    if (
      authorization.authenticated &&
      authorization.userId &&
      this.channelsByTwitchId.size > 0 &&
      !this.eventSubRunning &&
      this.signal &&
      !this.signal.aborted
    ) {
      this.eventSubRunning = true;
      try {
        await this.eventSub.start(authorization.userId, this.signal);
      } catch (error) {
        this.eventSubRunning = false;
        throw error;
      }
    } else if (
      this.eventSubRunning &&
      (!authorization.authenticated || this.channelsByTwitchId.size === 0)
    ) {
      this.eventSub.stop();
      this.eventSubRunning = false;
    }
  }

  private async handleAuthorizationChanged(authorization: TwitchAuthorization) {
    if (!authorization.authenticated) {
      this.eventSub.stop();
      this.eventSubRunning = false;
      await Promise.all(
        [...this.channelsByTwitchId.values()].map((channel) =>
          this.repository.setConnectionStatus(
            channel.storageId,
            "authorization_required",
            authorization.reason ?? "Connect Twitch to start logging",
          ),
        ),
      );
      return;
    }
    await this.synchronizeChannels(this.latestChannels);
  }

  private async handleConnectionStatus(
    status: "connecting" | "connected" | "disconnected" | "error",
    error?: string,
  ) {
    if (status === "error" && error === "Twitch authorization was revoked") {
      void this.auth.revalidate().catch((cause) =>
        this.logger.warn({ err: cause }, "Twitch authorization revalidation failed"),
      );
    }
    await Promise.all(
      [...this.channelsByTwitchId.values()].map((channel) =>
        this.repository
          .setConnectionStatus(channel.storageId, status, error)
          .catch((cause) =>
            this.logger.warn(
              { err: cause, channel: channel.username },
              "Could not update connection status",
            ),
          ),
      ),
    );
  }

  private async handleNotification(notification: TwitchChatNotification) {
    const event = notification.event;
    const channel = this.channelsByTwitchId.get(event.broadcaster_user_id);
    if (!channel) return;
    const message = normalizeChatMessage(notification);

    this.logger.info(
      { messageId: message.messageId, channel: message.channelName, user: message.username },
      "Received Twitch chat message",
    );
    for (const listener of this.listeners) listener(message);
    try {
      await this.repository.insertMessage(channel, message);
    } catch (error) {
      this.logger.error(
        { err: error, messageId: message.messageId, channel: channel.username },
        "Failed to store Twitch chat message",
      );
    }
  }
}
