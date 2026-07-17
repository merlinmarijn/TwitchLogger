export interface TwitchOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  frontendUrl: string;
  eventSubUrl: string;
  tokenEncryptionKey: Buffer;
  tokenStorePath: string;
  initialAccessToken?: string;
  initialRefreshToken?: string;
}

export interface WorkerOptions {
  convexUrl: string;
  publicWorkerUrl: string;
  ingestionSecret: string;
  port: number;
  logLevel: string;
  twitch: TwitchOptions;
}

export interface TwitchTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
}

export interface TwitchAuthorization {
  authenticated: boolean;
  userId?: string;
  login?: string;
  scopes: string[];
  expiresAt?: number;
  reason?: string;
}

export interface TwitchUser {
  id: string;
  login: string;
  displayName: string;
}

export interface TwitchBadge {
  setId: string;
  id: string;
  info: string;
}

export interface TwitchChatBadgeDefinition {
  setId: string;
  id: string;
  imageUrl: string;
  title: string;
  description: string;
}

export interface TwitchChatMessage {
  messageId: string;
  eventNotificationId: string;
  channelId: string;
  channelName: string;
  userId: string;
  username: string;
  displayName: string;
  messageText: string;
  messageTimestamp: Date;
  badges: TwitchBadge[];
  userColor?: string;
  isBroadcaster: boolean;
  isModerator: boolean;
  isSubscriber: boolean;
  isVip: boolean;
  messageType: string;
  metadata: Record<string, unknown>;
  rawMessageData: unknown;
}

export interface FollowedChannel {
  _id: string;
  platform: string;
  externalChannelId?: string;
  username: string;
  displayName: string;
  loggingEnabled: boolean;
  connectionStatus: string;
}

export interface ResolvedChannel {
  convexId: string;
  twitchId: string;
  username: string;
  displayName: string;
}

export class TwitchAuthError extends Error {
  constructor(
    message: string,
    public readonly authorizationRevoked = false,
  ) {
    super(message);
    this.name = "TwitchAuthError";
  }
}

export class TwitchApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly responseBody?: unknown,
  ) {
    super(message);
    this.name = "TwitchApiError";
  }
}
