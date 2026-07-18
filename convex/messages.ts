import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { mutation, query } from "./functions";
import { requireIngestionSecret } from "./lib/ingestionAuth";
import { extractImageUrls } from "../shared/imageUrls";

const badgeValidator = v.object({
  setId: v.string(),
  id: v.string(),
  info: v.string(),
});

export const listRecent = query({
  args: {
    channelId: v.optional(v.id("channels")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(args.limit ?? 200, 500));
    const messages = args.channelId
      ? await ctx.db
          .query("chatMessages")
          .withIndex("by_channel_timestamp", (q) =>
            q.eq("channelId", args.channelId!),
          )
          .order("desc")
          .take(limit)
      : await ctx.db
          .query("chatMessages")
          .withIndex("by_timestamp")
          .order("desc")
          .take(limit);
    return messages.reverse();
  },
});

export const page = query({
  args: {
    channelId: v.optional(v.id("channels")),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    if (args.channelId) {
      return ctx.db
        .query("chatMessages")
        .withIndex("by_channel_timestamp", (q) =>
          q.eq("channelId", args.channelId!),
        )
        .order("desc")
        .paginate(args.paginationOpts);
    }
    return ctx.db
      .query("chatMessages")
      .withIndex("by_timestamp")
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

export const pageImages = query({
  args: {
    channelId: v.optional(v.id("channels")),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const result = args.channelId
      ? await ctx.db
          .query("chatMessages")
          .withIndex("by_channel_timestamp", (q) =>
            q.eq("channelId", args.channelId!),
          )
          .order("desc")
          .paginate(args.paginationOpts)
      : await ctx.db
          .query("chatMessages")
          .withIndex("by_timestamp")
          .order("desc")
          .paginate(args.paginationOpts);

    return {
      ...result,
      page: result.page.flatMap((message) => {
        const imageUrls = extractImageUrls(message.messageText);
        if (imageUrls.length === 0) return [];

        return [{
          _id: message._id,
          channelId: message.channelId,
          platform: message.platform,
          externalMessageId: message.externalMessageId,
          externalChannelId: message.externalChannelId,
          channelName: message.channelName,
          senderId: message.senderId,
          senderUsername: message.senderUsername,
          senderDisplayName: message.senderDisplayName,
          messageText: message.messageText,
          timestamp: message.timestamp,
          badges: message.badges,
          userColor: message.userColor,
          isBroadcaster: message.isBroadcaster,
          isModerator: message.isModerator,
          isSubscriber: message.isSubscriber,
          isVip: message.isVip,
          messageType: message.messageType,
          imageUrls,
        }];
      }),
    };
  },
});

export const search = query({
  args: {
    text: v.string(),
    channelId: v.optional(v.id("channels")),
    senderUsername: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const text = args.text.trim();
    if (!text) return [];
    return ctx.db
      .query("chatMessages")
      .withSearchIndex("search_text", (q) => {
        let search = q.search("messageText", text).eq("platform", "twitch");
        if (args.channelId) search = search.eq("channelId", args.channelId);
        if (args.senderUsername) {
          search = search.eq("senderUsername", args.senderUsername.toLowerCase());
        }
        return search;
      })
      .take(Math.max(1, Math.min(args.limit ?? 100, 250)));
  },
});

export const insertIncoming = mutation({
  args: {
    ingestionSecret: v.string(),
    channelId: v.id("channels"),
    externalMessageId: v.string(),
    eventNotificationId: v.string(),
    externalChannelId: v.string(),
    channelName: v.string(),
    senderId: v.string(),
    senderUsername: v.string(),
    senderDisplayName: v.string(),
    messageText: v.string(),
    timestamp: v.number(),
    badges: v.array(badgeValidator),
    userColor: v.optional(v.string()),
    isBroadcaster: v.boolean(),
    isModerator: v.boolean(),
    isSubscriber: v.boolean(),
    isVip: v.boolean(),
    messageType: v.string(),
    metadata: v.any(),
    rawMessageData: v.any(),
  },
  handler: async (ctx, args) => {
    requireIngestionSecret(args.ingestionSecret);

    const duplicate = await ctx.db
      .query("chatMessages")
      .withIndex("by_external_message", (q) =>
        q.eq("externalMessageId", args.externalMessageId),
      )
      .unique();
    if (duplicate) return { inserted: false, id: duplicate._id };

    const { ingestionSecret, ...message } = args;
    void ingestionSecret;
    const id = await ctx.db.insert("chatMessages", {
      ...message,
      platform: "twitch",
      createdAt: Date.now(),
    });
    await ctx.db.patch(args.channelId, {
      lastMessageAt: args.timestamp,
      connectionStatus: "connected",
      connectionError: undefined,
      updatedAt: Date.now(),
    });
    return { inserted: true, id };
  },
});
