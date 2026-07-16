import { setTimeout as delay } from "node:timers/promises";
import WebSocket, { type RawData } from "ws";
import type { Logger } from "../logger";
import type { ResolvedChannel } from "../types";
import type { TwitchApiClient } from "./TwitchApiClient";

interface EventSubMetadata {
  message_id: string;
  message_type:
    | "session_welcome"
    | "session_keepalive"
    | "session_reconnect"
    | "notification"
    | "revocation";
  message_timestamp: string;
  subscription_type?: string;
}

interface EventSubSession {
  id: string;
  keepalive_timeout_seconds: number | null;
  reconnect_url: string | null;
}

export interface TwitchChatEvent {
  broadcaster_user_id: string;
  broadcaster_user_login: string;
  broadcaster_user_name: string;
  chatter_user_id: string;
  chatter_user_login: string;
  chatter_user_name: string;
  message_id: string;
  message: { text: string; fragments: unknown[] };
  color: string;
  badges: Array<{ set_id: string; id: string; info: string }>;
  message_type: string;
  [key: string]: unknown;
}

export interface TwitchChatNotification {
  metadata: EventSubMetadata;
  event: TwitchChatEvent;
  raw: unknown;
}

interface EventSubEnvelope {
  metadata: EventSubMetadata;
  payload: {
    session?: EventSubSession;
    subscription?: {
      id: string;
      status: string;
      type: string;
      condition: Record<string, string>;
    };
    event?: TwitchChatEvent;
  };
}

interface SocketContext {
  socket: WebSocket;
  sessionId?: string;
  keepaliveTimeoutMs: number;
  lastActivityAt: number;
  carriedSubscriptions: boolean;
  keepaliveTimer?: NodeJS.Timeout;
  suppressed: boolean;
}

type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

export class TwitchEventSubClient {
  private desiredChannels = new Map<string, ResolvedChannel>();
  private subscriptionIds = new Map<string, string>();
  private active?: SocketContext;
  private running = false;
  private chattingUserId = "";
  private reconnectAttempt = 0;
  private readonly notificationIds = new Map<string, number>();
  private readonly messageListeners = new Set<(event: TwitchChatNotification) => void>();
  private readonly statusListeners = new Set<
    (status: ConnectionStatus, error?: string) => void
  >();
  private signal?: AbortSignal;
  private reconnectPromise?: Promise<void>;

  constructor(
    private readonly url: string,
    private readonly api: TwitchApiClient,
    private readonly logger: Logger,
  ) {}

  onNotification(listener: (event: TwitchChatNotification) => void) {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onStatus(listener: (status: ConnectionStatus, error?: string) => void) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  async start(chattingUserId: string, signal: AbortSignal) {
    if (this.running) return;
    this.running = true;
    this.chattingUserId = chattingUserId;
    this.signal = signal;
    signal.addEventListener("abort", () => this.stop(), { once: true });
    try {
      await this.openSocket(this.url, false);
    } catch {
      void this.scheduleReconnect();
    }
  }

  stop() {
    this.running = false;
    this.subscriptionIds.clear();
    if (this.active) {
      this.active.suppressed = true;
      clearTimeout(this.active.keepaliveTimer);
      this.active.socket.close(1000, "Client stopping");
      this.active = undefined;
    }
    this.emitStatus("disconnected");
  }

  async setChannels(channels: ResolvedChannel[]) {
    const next = new Map(channels.map((channel) => [channel.twitchId, channel]));
    const removed = [...this.desiredChannels.keys()].filter((id) => !next.has(id));
    const added = [...next.keys()].filter((id) => !this.desiredChannels.has(id));
    this.desiredChannels = next;

    for (const broadcasterId of removed) {
      const subscriptionId = this.subscriptionIds.get(broadcasterId);
      this.subscriptionIds.delete(broadcasterId);
      if (subscriptionId) {
        await this.api.deleteSubscription(subscriptionId, this.signal).catch((error) =>
          this.logger.warn(
            { err: error, broadcasterId },
            "Could not remove Twitch chat subscription",
          ),
        );
      }
    }

    if (this.active?.sessionId) {
      for (const broadcasterId of added) await this.subscribe(broadcasterId);
    }
  }

  private async openSocket(url: string, carriedSubscriptions: boolean): Promise<void> {
    if (!this.running || this.signal?.aborted) return;
    this.emitStatus("connecting");
    this.logger.info(
      { reconnect: this.reconnectAttempt > 0, carriedSubscriptions },
      "Connecting to Twitch EventSub WebSocket",
    );

    const socket = new WebSocket(url);
    const context: SocketContext = {
      socket,
      keepaliveTimeoutMs: 30_000,
      lastActivityAt: Date.now(),
      carriedSubscriptions,
      suppressed: false,
    };

    await new Promise<void>((resolve, reject) => {
      const onErrorBeforeWelcome = (error: Error) => reject(error);
      socket.once("error", onErrorBeforeWelcome);
      socket.on("message", (data) => {
        void this.handleMessage(context, data)
          .then((welcomed) => {
            if (welcomed) {
              socket.off("error", onErrorBeforeWelcome);
              resolve();
            }
          })
          .catch((error) => this.handleProtocolError(context, error));
      });
      socket.on("error", (error) =>
        this.logger.error({ err: error }, "Twitch EventSub WebSocket error"),
      );
      socket.on("close", (code, reason) => {
        if (!context.sessionId) reject(new Error(`EventSub closed before welcome (${code})`));
        void this.handleClose(context, code, reason.toString());
      });
      this.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("Operation aborted", "AbortError")),
        { once: true },
      );
    }).catch((error) => {
      context.suppressed = true;
      socket.close();
      if (!this.running || this.signal?.aborted) return;
      this.logger.error({ err: error }, "Twitch EventSub connection failed");
      this.emitStatus("error", "Unable to connect to Twitch EventSub");
      throw error;
    });
  }

  private async handleMessage(context: SocketContext, data: RawData): Promise<boolean> {
    let envelope: EventSubEnvelope;
    try {
      envelope = JSON.parse(data.toString()) as EventSubEnvelope;
    } catch {
      this.logger.warn("Ignored malformed Twitch EventSub message");
      return false;
    }
    context.lastActivityAt = Date.now();

    switch (envelope.metadata.message_type) {
      case "session_welcome": {
        const session = envelope.payload.session;
        if (!session) throw new Error("EventSub welcome did not include a session");
        context.sessionId = session.id;
        context.keepaliveTimeoutMs = (session.keepalive_timeout_seconds ?? 30) * 1000;
        this.armKeepaliveTimer(context);

        const previous = this.active;
        this.active = context;
        this.reconnectAttempt = 0;
        if (previous && previous !== context) {
          previous.suppressed = true;
          clearTimeout(previous.keepaliveTimer);
          previous.socket.close(1000, "Twitch reconnect completed");
        }

        if (!context.carriedSubscriptions) {
          this.subscriptionIds.clear();
          for (const broadcasterId of this.desiredChannels.keys()) {
            await this.subscribe(broadcasterId);
          }
        }
        this.logger.info(
          { sessionId: session.id, channels: this.desiredChannels.size },
          "Twitch EventSub WebSocket ready",
        );
        this.emitStatus("connected");
        return true;
      }
      case "session_keepalive":
        this.armKeepaliveTimer(context);
        break;
      case "session_reconnect": {
        const reconnectUrl = envelope.payload.session?.reconnect_url;
        if (!reconnectUrl) throw new Error("EventSub reconnect message had no URL");
        this.logger.info("Twitch requested an EventSub WebSocket reconnect");
        await this.openSocket(reconnectUrl, true);
        break;
      }
      case "notification":
        this.armKeepaliveTimer(context);
        if (
          envelope.metadata.subscription_type === "channel.chat.message" &&
          envelope.payload.event &&
          !this.isDuplicateNotification(envelope.metadata.message_id)
        ) {
          const notification = {
            metadata: envelope.metadata,
            event: envelope.payload.event,
            raw: envelope,
          };
          for (const listener of this.messageListeners) listener(notification);
        }
        break;
      case "revocation": {
        const subscription = envelope.payload.subscription;
        this.logger.error(
          { subscriptionId: subscription?.id, status: subscription?.status },
          "Twitch revoked an EventSub subscription",
        );
        this.emitStatus(
          "error",
          subscription?.status === "authorization_revoked"
            ? "Twitch authorization was revoked"
            : `Twitch subscription revoked: ${subscription?.status ?? "unknown"}`,
        );
        break;
      }
    }
    return false;
  }

  private async subscribe(broadcasterId: string) {
    const sessionId = this.active?.sessionId;
    if (!sessionId || this.subscriptionIds.has(broadcasterId)) return;
    try {
      const subscriptionId = await this.api.createChatSubscription(
        broadcasterId,
        this.chattingUserId,
        sessionId,
        this.signal,
      );
      this.subscriptionIds.set(broadcasterId, subscriptionId);
    } catch (error) {
      this.logger.error(
        { err: error, broadcasterId },
        "Failed to create Twitch chat subscription",
      );
      this.emitStatus("error", "Failed to subscribe to Twitch chat");
    }
  }

  private armKeepaliveTimer(context: SocketContext) {
    clearTimeout(context.keepaliveTimer);
    context.keepaliveTimer = setTimeout(() => {
      if (Date.now() - context.lastActivityAt >= context.keepaliveTimeoutMs + 2_000) {
        this.logger.warn("Twitch EventSub keepalive timed out");
        context.socket.terminate();
      } else {
        this.armKeepaliveTimer(context);
      }
    }, context.keepaliveTimeoutMs + 2_000);
    context.keepaliveTimer.unref();
  }

  private async handleClose(context: SocketContext, code: number, reason: string) {
    clearTimeout(context.keepaliveTimer);
    this.logger.info({ code, reason }, "Twitch EventSub WebSocket closed");
    if (context.suppressed || !this.running || this.signal?.aborted) return;
    if (this.active === context) this.active = undefined;
    this.subscriptionIds.clear();
    this.emitStatus("disconnected");
    await this.scheduleReconnect();
  }

  private async scheduleReconnect() {
    if (!this.running || this.signal?.aborted || this.active) return;
    if (this.reconnectPromise) return this.reconnectPromise;
    this.reconnectPromise = (async () => {
      const waitMs =
        Math.min(30_000, 1_000 * 2 ** this.reconnectAttempt) + Math.random() * 500;
      this.reconnectAttempt += 1;
      this.logger.info({ waitMs: Math.round(waitMs) }, "Scheduling Twitch EventSub reconnect");
      await delay(waitMs, undefined, { signal: this.signal }).catch(() => undefined);
      if (this.running && !this.signal?.aborted && !this.active) {
        await this.openSocket(this.url, false).catch(() => undefined);
      }
    })().finally(() => {
      this.reconnectPromise = undefined;
      if (this.running && !this.signal?.aborted && !this.active) {
        queueMicrotask(() => void this.scheduleReconnect());
      }
    });
    return this.reconnectPromise;
  }

  private handleProtocolError(context: SocketContext, error: unknown) {
    this.logger.error({ err: error }, "Failed to process Twitch EventSub message");
    this.emitStatus("error", "Invalid message received from Twitch EventSub");
    context.socket.terminate();
  }

  private isDuplicateNotification(id: string) {
    const now = Date.now();
    if (this.notificationIds.has(id)) return true;
    this.notificationIds.set(id, now);
    if (this.notificationIds.size > 10_000) {
      const cutoff = now - 10 * 60 * 1000;
      for (const [candidate, seenAt] of this.notificationIds) {
        if (seenAt < cutoff || this.notificationIds.size > 9_000) {
          this.notificationIds.delete(candidate);
        }
      }
    }
    return false;
  }

  private emitStatus(status: ConnectionStatus, error?: string) {
    for (const listener of this.statusListeners) listener(status, error);
  }
}
