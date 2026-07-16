import { ConvexClient } from "convex/browser";
import { ConvexHttpClient } from "convex/browser";
import {
  makeFunctionReference,
  type FunctionReference,
} from "convex/server";
import type { Logger } from "./logger";
import type {
  FollowedChannel,
  ResolvedChannel,
  TwitchChatMessage,
} from "./types";

const listLogging = makeFunctionReference<
  "query",
  Record<string, never>,
  FollowedChannel[]
>("channels:listLogging");

type ChannelStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error"
  | "authorization_required";

const updateResolved = makeFunctionReference<
  "mutation",
  {
    ingestionSecret: string;
    id: string;
    externalChannelId: string;
    username: string;
    displayName: string;
  },
  null
>("channels:updateResolved");

const updateConnectionStatus = makeFunctionReference<
  "mutation",
  {
    ingestionSecret: string;
    id: string;
    status: ChannelStatus;
    error?: string;
  },
  null
>("channels:updateConnectionStatus");

const insertIncoming = makeFunctionReference<
  "mutation",
  {
    ingestionSecret: string;
    channelId: string;
    externalMessageId: string;
    eventNotificationId: string;
    externalChannelId: string;
    channelName: string;
    senderId: string;
    senderUsername: string;
    senderDisplayName: string;
    messageText: string;
    timestamp: number;
    badges: TwitchChatMessage["badges"];
    userColor?: string;
    isBroadcaster: boolean;
    isModerator: boolean;
    isSubscriber: boolean;
    isVip: boolean;
    messageType: string;
    metadata: Record<string, unknown>;
    rawMessageData: unknown;
  },
  { inserted: boolean; id: string }
>("messages:insertIncoming");

export class ConvexChatRepository {
  private readonly realtime: ConvexClient;
  private readonly http: ConvexHttpClient;

  constructor(
    convexUrl: string,
    private readonly ingestionSecret: string,
    private readonly logger: Logger,
  ) {
    this.realtime = new ConvexClient(convexUrl);
    this.http = new ConvexHttpClient(convexUrl);
  }

  watchLoggingChannels(
    onUpdate: (channels: FollowedChannel[]) => void,
    onError: (error: Error) => void,
  ) {
    const unsubscribe = this.realtime.onUpdate(
      listLogging as FunctionReference<"query">,
      {},
      (channels) => onUpdate(channels as FollowedChannel[]),
      onError,
    );
    return unsubscribe;
  }

  async saveResolvedChannel(channel: ResolvedChannel) {
    await this.http.mutation(updateResolved as FunctionReference<"mutation">, {
      ingestionSecret: this.ingestionSecret,
      id: channel.convexId,
      externalChannelId: channel.twitchId,
      username: channel.username,
      displayName: channel.displayName,
    });
  }

  async setConnectionStatus(id: string, status: ChannelStatus, error?: string) {
    await this.http.mutation(updateConnectionStatus as FunctionReference<"mutation">, {
      ingestionSecret: this.ingestionSecret,
      id,
      status,
      ...(error ? { error } : {}),
    });
  }

  async insertMessage(channel: ResolvedChannel, message: TwitchChatMessage) {
    const result = (await this.http.mutation(
      insertIncoming as FunctionReference<"mutation">,
      {
        ingestionSecret: this.ingestionSecret,
        channelId: channel.convexId,
        externalMessageId: message.messageId,
        eventNotificationId: message.eventNotificationId,
        externalChannelId: message.channelId,
        channelName: message.channelName,
        senderId: message.userId,
        senderUsername: message.username,
        senderDisplayName: message.displayName,
        messageText: message.messageText,
        timestamp: message.messageTimestamp.getTime(),
        badges: message.badges,
        userColor: message.userColor,
        isBroadcaster: message.isBroadcaster,
        isModerator: message.isModerator,
        isSubscriber: message.isSubscriber,
        isVip: message.isVip,
        messageType: message.messageType,
        metadata: message.metadata,
        rawMessageData: message.rawMessageData,
      },
    )) as { inserted: boolean; id: string };
    if (!result.inserted) {
      this.logger.debug({ messageId: message.messageId }, "Ignored duplicate chat message");
    }
  }

  close() {
    this.realtime.close();
  }
}
