import { paginationOptsValidator, type TransactionMetrics } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, mutation, query } from "./functions";
import { toClientMessage } from "./lib/clientMessage";
import { requireIngestionSecret } from "./lib/ingestionAuth";
import {
  countFilterMatches,
  hasMessageSelection,
  matchesCriteria,
  messageCriteriaValidators,
  messageFilterValidator,
  validateMessageCriteria,
  validateMessagePageSize,
} from "./lib/messageFilters";
import { paginateMatching } from "./lib/messagePagination";
import { extractImageUrls } from "../shared/imageUrls";

const FILTER_SCAN_MINIMUM_BYTES_REMAINING = 2 * 1024 * 1024;
const FILTER_SCAN_MINIMUM_DOCUMENTS_REMAINING = 100;

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
    return messages.reverse().map(toClientMessage);
  },
});

export const page = query({
  args: {
    channelId: v.optional(v.id("channels")),
    paginationOpts: paginationOptsValidator,
    ...messageCriteriaValidators,
  },
  handler: async (ctx, args) => {
    validateMessagePageSize(args.paginationOpts.numItems);
    const criteria = validateMessageCriteria(args);
    const loadPage = (paginationOpts: typeof args.paginationOpts) => args.channelId
      ? ctx.db
        .query("chatMessages")
        .withIndex("by_channel_timestamp", (q) =>
          criteria.afterTimestamp
            ? q.eq("channelId", args.channelId!).gt("timestamp", criteria.afterTimestamp)
            : q.eq("channelId", args.channelId!),
        )
        .order("desc")
        .paginate(paginationOpts)
      : ctx.db
        .query("chatMessages")
        .withIndex("by_timestamp", (q) => criteria.afterTimestamp
          ? q.gt("timestamp", criteria.afterTimestamp)
          : q)
        .order("desc")
        .paginate(paginationOpts);
    const result = await paginateMatching({
      paginationOpts: args.paginationOpts,
      selectionActive: hasMessageSelection(criteria),
      matches: (message) => matchesCriteria(message, criteria),
      loadPage,
      canContinue: () => hasFilterScanHeadroom(ctx.meta.getTransactionMetrics()),
    });

    return { ...result, page: result.page.map(toClientMessage) };
  },
});

export const pageImages = query({
  args: {
    channelId: v.optional(v.id("channels")),
    paginationOpts: paginationOptsValidator,
    ...messageCriteriaValidators,
  },
  handler: async (ctx, args) => {
    validateMessagePageSize(args.paginationOpts.numItems);
    const criteria = validateMessageCriteria(args);
    const loadPage = (paginationOpts: typeof args.paginationOpts) => args.channelId
      ? ctx.db
          .query("chatMessages")
          .withIndex("by_gallery_channel_timestamp", (q) =>
            criteria.afterTimestamp
              ? q.eq("galleryChannelId", args.channelId!).gt("timestamp", criteria.afterTimestamp)
              : q.eq("galleryChannelId", args.channelId!),
          )
          .order("desc")
          .paginate(paginationOpts)
      : ctx.db
          .query("chatMessages")
          .withIndex("by_has_images_timestamp", (q) => criteria.afterTimestamp
            ? q.eq("hasImages", true).gt("timestamp", criteria.afterTimestamp)
            : q.eq("hasImages", true))
          .order("desc")
          .paginate(paginationOpts);
    const result = await paginateMatching({
      paginationOpts: args.paginationOpts,
      selectionActive: hasMessageSelection(criteria),
      matches: (message) => matchesCriteria(message, criteria),
      loadPage,
      canContinue: () => hasFilterScanHeadroom(ctx.meta.getTransactionMetrics()),
    });

    return {
      ...result,
      page: result.page.map((message) => ({
        ...toClientMessage(message),
        imageUrls: message.imageUrls ?? [],
      })),
    };
  },
});

async function hasFilterScanHeadroom(
  metricsPromise: Promise<TransactionMetrics>,
) {
  const metrics = await metricsPromise;
  return metrics.bytesRead.remaining >= FILTER_SCAN_MINIMUM_BYTES_REMAINING &&
    metrics.documentsRead.remaining >= FILTER_SCAN_MINIMUM_DOCUMENTS_REMAINING &&
    metrics.databaseQueries.remaining > 1;
}

export const filterMatchCounts = query({
  args: {
    channelId: v.optional(v.id("channels")),
    filters: v.array(messageFilterValidator),
    afterTimestamp: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const criteria = validateMessageCriteria(args);
    const messages = args.channelId
      ? await ctx.db
          .query("chatMessages")
          .withIndex("by_channel_timestamp", (q) => criteria.afterTimestamp
            ? q.eq("channelId", args.channelId!).gt("timestamp", criteria.afterTimestamp)
            : q.eq("channelId", args.channelId!))
          .order("desc")
          .take(500)
      : await ctx.db
          .query("chatMessages")
          .withIndex("by_timestamp", (q) => criteria.afterTimestamp
            ? q.gt("timestamp", criteria.afterTimestamp)
            : q)
          .order("desc")
          .take(500);

    return countFilterMatches(messages, criteria.filters);
  },
});

/**
 * Starts an idempotent background migration for messages saved before image
 * metadata was indexed. The worker invokes this once at startup.
 */
export const startImageIndexBackfill = mutation({
  args: { ingestionSecret: v.string() },
  handler: async (ctx, args): Promise<{ scheduled: boolean }> => {
    requireIngestionSecret(args.ingestionSecret);
    const unindexedMessage = await ctx.db
      .query("chatMessages")
      .withIndex("by_has_images_timestamp", (q) => q.eq("hasImages", undefined))
      .first();
    if (!unindexedMessage) return { scheduled: false };

    await ctx.scheduler.runAfter(0, internal.messages.backfillImageIndexBatch, {});
    return { scheduled: true };
  },
});

export const backfillImageIndexBatch = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ processed: number; complete: boolean }> => {
    const messages = await ctx.db
      .query("chatMessages")
      .withIndex("by_has_images_timestamp", (q) => q.eq("hasImages", undefined))
      .take(100);

    await Promise.all(messages.map(async (message) => {
      const imageUrls = extractImageUrls(message.messageText);
      await ctx.db.patch(message._id, {
        hasImages: imageUrls.length > 0,
        imageUrls,
        galleryChannelId: imageUrls.length > 0 ? message.channelId : undefined,
      });
    }));

    if (messages.length === 100) {
      await ctx.scheduler.runAfter(0, internal.messages.backfillImageIndexBatch, {});
    }
    return { processed: messages.length, complete: messages.length < 100 };
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
    const messages = await ctx.db
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
    return messages.map(toClientMessage);
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
    const imageUrls = extractImageUrls(message.messageText);
    const id = await ctx.db.insert("chatMessages", {
      ...message,
      hasImages: imageUrls.length > 0,
      imageUrls,
      galleryChannelId: imageUrls.length > 0 ? message.channelId : undefined,
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
