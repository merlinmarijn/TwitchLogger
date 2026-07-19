import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, mutation, query } from "./functions";
import {
  findTabByClientId,
  indexMessageForTabs,
  loadIndexedTabMessages,
  tabAsMessageFilter,
} from "./chatTabs";
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
import { extractImageUrls, IMAGE_INDEX_VERSION } from "../shared/imageUrls";
import {
  claimMaintenanceSlot,
  MAINTENANCE_BATCH_DELAY_MS,
  MAINTENANCE_WRITE_BATCH_SIZE,
} from "./lib/maintenancePacing";

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
    tabId: v.optional(v.string()),
    tabRevision: v.optional(v.number()),
    tabIndexRevision: v.optional(v.number()),
    paginationOpts: paginationOptsValidator,
    ...messageCriteriaValidators,
  },
  handler: async (ctx, args) => {
    validateMessagePageSize(args.paginationOpts.numItems);
    const baseCriteria = validateMessageCriteria(args);
    const tab = args.tabId ? await findTabByClientId(ctx, args.tabId) : null;
    if (args.tabId && !tab) throw new ConvexError("Unknown chat tab");
    const indexedRevision = tab && (args.tabIndexRevision ?? 0) > 0
      ? args.tabIndexRevision
      : undefined;
    const criteria = tab && indexedRevision === undefined
      ? { ...baseCriteria, filters: [...baseCriteria.filters, tabAsMessageFilter(tab)] }
      : baseCriteria;
    const loadPage = indexedRevision !== undefined && tab
      ? (paginationOpts: typeof args.paginationOpts) => loadIndexedTabMessages(ctx, {
          tab,
          revision: indexedRevision,
          paginationOpts,
          channelId: args.channelId,
          afterTimestamp: criteria.afterTimestamp,
          imagesOnly: false,
        })
      : (paginationOpts: typeof args.paginationOpts) => args.channelId
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
    });

    return { ...result, page: result.page.map(toClientMessage) };
  },
});

export const pageImages = query({
  args: {
    channelId: v.optional(v.id("channels")),
    tabId: v.optional(v.string()),
    tabRevision: v.optional(v.number()),
    tabIndexRevision: v.optional(v.number()),
    paginationOpts: paginationOptsValidator,
    ...messageCriteriaValidators,
  },
  handler: async (ctx, args) => {
    validateMessagePageSize(args.paginationOpts.numItems);
    const baseCriteria = validateMessageCriteria(args);
    const tab = args.tabId ? await findTabByClientId(ctx, args.tabId) : null;
    if (args.tabId && !tab) throw new ConvexError("Unknown chat tab");
    const indexedRevision = tab && (args.tabIndexRevision ?? 0) > 0
      ? args.tabIndexRevision
      : undefined;
    const criteria = tab && indexedRevision === undefined
      ? { ...baseCriteria, filters: [...baseCriteria.filters, tabAsMessageFilter(tab)] }
      : baseCriteria;
    const loadPage = indexedRevision !== undefined && tab
      ? (paginationOpts: typeof args.paginationOpts) => loadIndexedTabMessages(ctx, {
          tab,
          revision: indexedRevision,
          paginationOpts,
          channelId: args.channelId,
          afterTimestamp: criteria.afterTimestamp,
          imagesOnly: true,
        })
      : (paginationOpts: typeof args.paginationOpts) => args.channelId
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
 * metadata was indexed with the current URL support. The worker invokes this
 * once at startup and each document records the version it has completed.
 */
export const startImageIndexBackfill = mutation({
  args: { ingestionSecret: v.string() },
  handler: async (ctx, args): Promise<{ scheduled: boolean }> => {
    requireIngestionSecret(args.ingestionSecret);
    const unindexedMessage = await ctx.db
      .query("chatMessages")
      .withIndex("by_image_index_version", (q) => q.lt("imageIndexVersion", IMAGE_INDEX_VERSION))
      .first();
    if (!unindexedMessage) return { scheduled: false };

    await ctx.scheduler.runAfter(
      MAINTENANCE_BATCH_DELAY_MS,
      internal.messages.backfillImageIndexBatch,
      {},
    );
    return { scheduled: true };
  },
});

export const backfillImageIndexBatch = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ processed: number; complete: boolean }> => {
    const waitMs = await claimMaintenanceSlot(ctx);
    if (waitMs > 0) {
      await ctx.scheduler.runAfter(waitMs, internal.messages.backfillImageIndexBatch, {});
      return { processed: 0, complete: false };
    }
    const messages = await ctx.db
      .query("chatMessages")
      .withIndex("by_image_index_version", (q) => q.lt("imageIndexVersion", IMAGE_INDEX_VERSION))
      .take(MAINTENANCE_WRITE_BATCH_SIZE);

    await Promise.all(messages.map(async (message) => {
      const imageUrls = extractImageUrls(message.messageText);
      await ctx.db.patch(message._id, {
        hasImages: imageUrls.length > 0,
        imageUrls,
        imageIndexVersion: IMAGE_INDEX_VERSION,
        galleryChannelId: imageUrls.length > 0 ? message.channelId : undefined,
      });
      await indexMessageForTabs(ctx, {
        ...message,
        hasImages: imageUrls.length > 0,
        imageUrls,
        imageIndexVersion: IMAGE_INDEX_VERSION,
        galleryChannelId: imageUrls.length > 0 ? message.channelId : undefined,
      });
    }));

    if (messages.length === MAINTENANCE_WRITE_BATCH_SIZE) {
      await ctx.scheduler.runAfter(
        MAINTENANCE_BATCH_DELAY_MS,
        internal.messages.backfillImageIndexBatch,
        {},
      );
    }
    return {
      processed: messages.length,
      complete: messages.length < MAINTENANCE_WRITE_BATCH_SIZE,
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
      imageIndexVersion: IMAGE_INDEX_VERSION,
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
    const insertedMessage = await ctx.db.get(id);
    if (insertedMessage) await indexMessageForTabs(ctx, insertedMessage);
    return { inserted: true, id };
  },
});
