import { compactNativeEmotes } from "../../shared/nativeEmotes";
import type { TwitchChatMessage } from "../types";
import type { TwitchChatNotification } from "./TwitchEventSubClient";

export function normalizeChatMessage(
  notification: TwitchChatNotification,
): TwitchChatMessage {
  const event = notification.event;
  const badgeIds = new Set(event.badges.map((badge) => badge.set_id));
  return {
    messageId: event.message_id,
    eventNotificationId: notification.metadata.message_id,
    channelId: event.broadcaster_user_id,
    channelName: event.broadcaster_user_login,
    userId: event.chatter_user_id,
    username: event.chatter_user_login,
    displayName: event.chatter_user_name,
    messageText: event.message.text,
    messageTimestamp: new Date(notification.metadata.message_timestamp),
    badges: event.badges.map((badge) => ({
      setId: badge.set_id,
      id: badge.id,
      info: badge.info,
    })),
    userColor: event.color || undefined,
    isBroadcaster:
      event.chatter_user_id === event.broadcaster_user_id || badgeIds.has("broadcaster"),
    isModerator: badgeIds.has("moderator"),
    isSubscriber: badgeIds.has("subscriber") || badgeIds.has("founder"),
    isVip: badgeIds.has("vip"),
    messageType: event.message_type,
    nativeEmotes: compactNativeEmotes(event.message.fragments),
    rawMessageData: notification.raw,
  };
}
