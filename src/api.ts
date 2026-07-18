import {
  makeFunctionReference,
  type PaginationOptions,
  type PaginationResult,
} from "convex/server";
import type { MessageFilter } from "../shared/messageFilters";

export interface Channel {
  _id: string;
  platform: "twitch";
  externalChannelId?: string;
  username: string;
  displayName: string;
  loggingEnabled: boolean;
  connectionStatus:
    | "disconnected"
    | "connecting"
    | "connected"
    | "error"
    | "authorization_required";
  connectionError?: string;
  lastMessageAt?: number;
}

export interface ChatMessage {
  _id: string;
  externalChannelId: string;
  channelName: string;
  senderUsername: string;
  senderDisplayName: string;
  messageText: string;
  timestamp: number;
  badges: Array<{ setId: string; id: string; info: string }>;
  userColor?: string;
  isBroadcaster: boolean;
  isModerator: boolean;
  isSubscriber: boolean;
  isVip: boolean;
  messageType: string;
  imageUrls?: string[];
  metadata?: {
    fragments?: unknown;
    [key: string]: unknown;
  };
}

export interface ChatBadgeDefinition {
  setId: string;
  id: string;
  imageUrl: string;
  title: string;
  description: string;
}

export const api = {
  platforms: {
    ensureSeeded: makeFunctionReference<"mutation", Record<string, never>, null>(
      "platforms:ensureSeeded",
    ),
  },
  channels: {
    list: makeFunctionReference<"query", Record<string, never>, Channel[]>("channels:list"),
    add: makeFunctionReference<
      "mutation",
      {
        platform: "twitch";
        username: string;
        displayName?: string;
        loggingEnabled: boolean;
      },
      string
    >("channels:add"),
    setLogging: makeFunctionReference<
      "mutation",
      { id: string; enabled: boolean },
      null
    >("channels:setLogging"),
    reconnect: makeFunctionReference<"mutation", { id: string }, null>(
      "channels:reconnect",
    ),
    remove: makeFunctionReference<"mutation", { id: string }, null>("channels:remove"),
  },
  messages: {
    listRecent: makeFunctionReference<
      "query",
      { channelId?: string; limit?: number },
      ChatMessage[]
    >("messages:listRecent"),
    page: makeFunctionReference<
      "query",
      {
        channelId?: string;
        paginationOpts: PaginationOptions;
        quickSearch?: string;
        filters?: MessageFilter[];
        afterTimestamp?: number;
      },
      PaginationResult<ChatMessage>
    >("messages:page"),
    pageImages: makeFunctionReference<
      "query",
      {
        channelId?: string;
        paginationOpts: PaginationOptions;
        quickSearch?: string;
        filters?: MessageFilter[];
        afterTimestamp?: number;
      },
      PaginationResult<ChatMessage>
    >("messages:pageImages"),
    filterMatchCounts: makeFunctionReference<
      "query",
      { channelId?: string; filters: MessageFilter[]; afterTimestamp?: number },
      Array<{ id: string; count: number }>
    >("messages:filterMatchCounts"),
  },
};
