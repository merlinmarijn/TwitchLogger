import type { Doc } from "../_generated/dataModel";

/** Return only the message fields the browser can render or filter. */
export function toClientMessage(message: Doc<"chatMessages">) {
  const fragments = message.metadata?.fragments;
  return {
    _id: message._id,
    externalChannelId: message.externalChannelId,
    channelName: message.channelName,
    senderUsername: message.senderUsername,
    senderDisplayName: message.senderDisplayName,
    messageText: message.messageText,
    timestamp: message.timestamp,
    badges: message.badges,
    ...(message.userColor === undefined ? {} : { userColor: message.userColor }),
    isBroadcaster: message.isBroadcaster,
    isModerator: message.isModerator,
    isSubscriber: message.isSubscriber,
    isVip: message.isVip,
    messageType: message.messageType,
    ...(fragments === undefined ? {} : { metadata: { fragments } }),
  };
}
