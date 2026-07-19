import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const connectionStatus = v.union(
  v.literal("disconnected"),
  v.literal("connecting"),
  v.literal("connected"),
  v.literal("error"),
  v.literal("authorization_required"),
);

const filterRule = v.object({
  id: v.string(),
  field: v.union(
    v.literal("message"),
    v.literal("sender"),
    v.literal("channel"),
    v.literal("role"),
    v.literal("badge"),
    v.literal("messageType"),
  ),
  operator: v.union(
    v.literal("contains"),
    v.literal("notContains"),
    v.literal("equals"),
    v.literal("notEquals"),
    v.literal("startsWith"),
    v.literal("endsWith"),
    v.literal("wholeWord"),
    v.literal("regex"),
    v.literal("has"),
    v.literal("notHas"),
  ),
  value: v.string(),
});

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

  chatTabs: defineTable({
    clientId: v.string(),
    name: v.string(),
    layout: v.union(v.literal("chat"), v.literal("gallery")),
    match: v.union(v.literal("all"), v.literal("any")),
    rules: v.array(filterRule),
    revision: v.number(),
    indexedRevision: v.optional(v.number()),
    indexStatus: v.union(v.literal("building"), v.literal("ready")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_client_id", ["clientId"]),

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
    // Optional while existing deployments backfill older messages.
    hasImages: v.optional(v.boolean()),
    imageUrls: v.optional(v.array(v.string())),
    imageIndexVersion: v.optional(v.number()),
    galleryChannelId: v.optional(v.id("channels")),
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
    .index("by_has_images_timestamp", ["hasImages", "timestamp"])
    .index("by_image_index_version", ["imageIndexVersion"])
    .index("by_gallery_channel_timestamp", ["galleryChannelId", "timestamp"])
    .index("by_external_message", ["externalMessageId"])
    .index("by_event_notification", ["eventNotificationId"])
    .searchIndex("search_text", {
      searchField: "messageText",
      filterFields: ["channelId", "platform", "senderUsername"],
    }),

  chatTabMatches: defineTable({
    tabId: v.id("chatTabs"),
    revision: v.number(),
    messageId: v.id("chatMessages"),
    channelId: v.id("channels"),
    timestamp: v.number(),
    hasImages: v.boolean(),
  })
    .index("by_tab_revision_timestamp", ["tabId", "revision", "timestamp"])
    .index("by_tab_revision_channel_timestamp", [
      "tabId",
      "revision",
      "channelId",
      "timestamp",
    ])
    .index("by_tab_revision_images_timestamp", [
      "tabId",
      "revision",
      "hasImages",
      "timestamp",
    ])
    .index("by_tab_revision_channel_images_timestamp", [
      "tabId",
      "revision",
      "channelId",
      "hasImages",
      "timestamp",
    ])
    .index("by_tab_revision_message", ["tabId", "revision", "messageId"]),
});
