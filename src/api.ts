import type { MessageFilter } from "../shared/messageFilters";
import type { NativeEmote } from "../shared/nativeEmotes";
import type { ChatViewTab } from "./chatTabModel";

export interface Channel {
  _id: string;
  platform: "twitch";
  externalChannelId?: string;
  username: string;
  displayName: string;
  loggingEnabled: boolean;
  connectionStatus: "disconnected" | "connecting" | "connected" | "error" | "authorization_required";
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
  nativeEmotes?: NativeEmote[];
}

export interface ChatBadgeDefinition {
  setId: string;
  id: string;
  imageUrl: string;
  title: string;
  description: string;
}

export interface MessageUserSuggestion {
  username: string;
  displayName: string;
  messageCount: number;
}

export interface MessageSearchSuggestions {
  query: string;
  channelId?: string;
  users: MessageUserSuggestion[];
}

export interface ApiOperation<Args, Result> {
  path: string;
  method: "GET" | "POST";
  pollIntervalMs?: number;
  _args?: Args;
  _result?: Result;
}

export interface PaginationResult<T> {
  page: T[];
  isDone: boolean;
  continueCursor: string;
}

function operation<Args, Result>(
  path: string,
  method: "GET" | "POST",
  pollIntervalMs?: number,
) {
  return { path, method, pollIntervalMs } as ApiOperation<Args, Result>;
}

type MessagePageArgs = {
  channelId?: string;
  tabId?: string;
  tabRevision?: number;
  tabIndexRevision?: number;
  paginationOpts: { numItems: number; cursor?: string | null };
  quickSearch?: string;
  filters?: MessageFilter[];
  afterTimestamp?: number;
};

export const api = {
  feedback: {
    status: operation<Record<string, never>, {
      limited: boolean;
      retryAfterSeconds: number;
      retryAt?: number;
    }>("/api/feedback/status", "GET"),
    submit: operation<{
      kind: "feedback" | "issue";
      description: string;
      contactUsername?: string;
    }, {
      submitted: true;
      retryAfterSeconds: number;
      retryAt: number;
    }>("/api/feedback", "POST"),
  },
  platforms: {
    ensureSeeded: operation<Record<string, never>, null>("/api/data/platforms/ensure-seeded", "POST"),
  },
  channels: {
    list: operation<Record<string, never>, Channel[]>("/api/data/channels", "GET", 5_000),
    add: operation<{ platform: "twitch"; username: string; displayName?: string; loggingEnabled: boolean }, string>("/api/data/channels/add", "POST"),
    setLogging: operation<{ id: string; enabled: boolean }, null>("/api/data/channels/set-logging", "POST"),
    reconnect: operation<{ id: string }, null>("/api/data/channels/reconnect", "POST"),
    remove: operation<{ id: string }, null>("/api/data/channels/remove", "POST"),
  },
  chatTabs: {
    list: operation<Record<string, never>, ChatViewTab[]>("/api/data/chat-tabs", "GET", 10_000),
    save: operation<{ tab: Pick<ChatViewTab, "id" | "name" | "layout" | "match" | "rules"> }, null>("/api/data/chat-tabs/save", "POST"),
    importLocal: operation<{ tabs: Array<Pick<ChatViewTab, "id" | "name" | "layout" | "match" | "rules">> }, null>("/api/data/chat-tabs/import", "POST"),
    remove: operation<{ id: string }, null>("/api/data/chat-tabs/remove", "POST"),
  },
  messages: {
    page: operation<MessagePageArgs, PaginationResult<ChatMessage>>("/api/data/messages/page", "POST", 2_000),
    pageImages: operation<MessagePageArgs, PaginationResult<ChatMessage>>("/api/data/messages/page-images", "POST", 4_000),
    pageGameScores: operation<MessagePageArgs, PaginationResult<ChatMessage>>("/api/data/messages/page-game-scores", "POST", 5_000),
    suggestions: operation<{
      text: string;
      channelId?: string;
      limit?: number;
    }, MessageSearchSuggestions>("/api/data/messages/suggestions", "POST"),
    filterMatchCounts: operation<{ channelId?: string; filters: MessageFilter[]; afterTimestamp?: number }, Array<{ id: string; count: number }>>("/api/data/messages/filter-counts", "POST", 15_000),
    delete: operation<{ messageIds: string[] }, { deleted: number }>("/api/data/messages/delete", "POST"),
    hideImages: operation<{
      images: Array<{ messageId: string; url: string }>;
    }, { hidden: number }>("/api/data/messages/hide-images", "POST"),
  },
};
