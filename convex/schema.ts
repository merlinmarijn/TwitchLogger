import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const connectionStatus = v.union(
  v.literal("disconnected"),
  v.literal("connecting"),
  v.literal("connected"),
  v.literal("error"),
  v.literal("authorization_required"),
);

export default defineSchema({
  platforms: defineTable({
    name: v.string(),
    slug: v.string(),
    enabled: v.boolean(),
    createdAt: v.number(),
  }).index("by_slug", ["slug"]),

  channels: defineTable({
    platform: v.string(),
    externalChannelId: v.optional(v.string()),
    username: v.string(),
    displayName: v.string(),
    loggingEnabled: v.boolean(),
    connectionStatus,
    connectionError: v.optional(v.string()),
    hiddenAt: v.optional(v.number()),
    lastConnectedAt: v.optional(v.number()),
    lastMessageAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_platform_username", ["platform", "username"])
    .index("by_logging", ["loggingEnabled"])
    .index("by_last_message", ["lastMessageAt"])
    .index("by_external_id", ["externalChannelId"]),

  chatMessages: defineTable({
    channelId: v.id("channels"),
    platform: v.string(),
    externalMessageId: v.string(),
    eventNotificationId: v.string(),
    externalChannelId: v.string(),
    channelName: v.string(),
    senderId: v.string(),
    senderUsername: v.string(),
    senderDisplayName: v.string(),
    messageText: v.string(),
    timestamp: v.number(),
    badges: v.array(
      v.object({
        setId: v.string(),
        id: v.string(),
        info: v.string(),
      }),
    ),
    userColor: v.optional(v.string()),
    isBroadcaster: v.boolean(),
    isModerator: v.boolean(),
    isSubscriber: v.boolean(),
    isVip: v.boolean(),
    messageType: v.string(),
    metadata: v.any(),
    rawMessageData: v.any(),
    createdAt: v.number(),
  })
    .index("by_channel_timestamp", ["channelId", "timestamp"])
    .index("by_platform_timestamp", ["platform", "timestamp"])
    .index("by_sender", ["senderUsername", "timestamp"])
    .index("by_timestamp", ["timestamp"])
    .index("by_external_message", ["externalMessageId"])
    .index("by_event_notification", ["eventNotificationId"])
    .searchIndex("search_text", {
      searchField: "messageText",
      filterFields: ["channelId", "platform", "senderUsername"],
    }),
});
