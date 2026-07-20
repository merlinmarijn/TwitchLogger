import type { FollowedChannel, ResolvedChannel, TwitchChatMessage } from "./types";

export type ChannelStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error"
  | "authorization_required";

export interface ChatRepository {
  watchLoggingChannels(
    onUpdate: (channels: FollowedChannel[]) => void,
    onError: (error: Error) => void,
  ): () => void;
  saveResolvedChannel(channel: ResolvedChannel): Promise<void>;
  setConnectionStatus(id: string, status: ChannelStatus, error?: string): Promise<void>;
  insertMessage(channel: ResolvedChannel, message: TwitchChatMessage): Promise<void>;
  close(): void | Promise<void>;
}
