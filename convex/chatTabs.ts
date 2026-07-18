import {
  anyApi,
  type PaginationOptions,
  type PaginationResult,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./functions";
import {
  filterRuleValidator,
  validateMessageCriteria,
} from "./lib/messageFilters";
import {
  matchesMessageFilter,
  type FilterMatchMode,
  type FilterRule,
  type FilterableMessage,
  type MessageFilter,
} from "../shared/messageFilters";
import { extractImageUrls } from "../shared/imageUrls";

const MAX_CHAT_TABS = 20;
const TAB_INDEX_BATCH_SIZE = 100;

const chatTabInputValidator = v.object({
  id: v.string(),
  name: v.string(),
  layout: v.union(v.literal("chat"), v.literal("gallery")),
  match: v.union(v.literal("all"), v.literal("any")),
  rules: v.array(filterRuleValidator),
});

export interface ChatTabInput {
  id: string;
  name: string;
  layout: "chat" | "gallery";
  match: FilterMatchMode;
  rules: FilterRule[];
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    const tabs = await ctx.db.query("chatTabs").take(MAX_CHAT_TABS + 1);
    return tabs
      .sort((left, right) => left.createdAt - right.createdAt)
      .slice(0, MAX_CHAT_TABS)
      .map(toClientTab);
  },
});

export const save = mutation({
  args: { tab: chatTabInputValidator },
  handler: async (ctx, { tab }) => {
    const normalized = validateTab(tab);
    const existing = await findTab(ctx, normalized.id);
    const now = Date.now();

    if (!existing) {
      const tabs = await ctx.db.query("chatTabs").take(MAX_CHAT_TABS);
      if (tabs.length >= MAX_CHAT_TABS) {
        throw new ConvexError(`Chat tabs are limited to ${MAX_CHAT_TABS}`);
      }
      const tabId = await ctx.db.insert("chatTabs", {
        clientId: normalized.id,
        name: normalized.name,
        layout: normalized.layout,
        match: normalized.match,
        rules: normalized.rules,
        revision: 1,
        indexStatus: "building",
        createdAt: now,
        updatedAt: now,
      });
      await scheduleRebuild(ctx, tabId, 1);
      return null;
    }

    const conditionsChanged = tabConditionsKey(existing) !== tabConditionsKey(normalized);
    const revision = conditionsChanged ? existing.revision + 1 : existing.revision;
    await ctx.db.patch(existing._id, {
      name: normalized.name,
      layout: normalized.layout,
      match: normalized.match,
      rules: normalized.rules,
      revision,
      ...(conditionsChanged ? { indexStatus: "building" as const } : {}),
      updatedAt: now,
    });
    if (conditionsChanged) await scheduleRebuild(ctx, existing._id, revision);
    return null;
  },
});

export const importLocal = mutation({
  args: { tabs: v.array(chatTabInputValidator) },
  handler: async (ctx, { tabs }) => {
    if (tabs.length > MAX_CHAT_TABS) {
      throw new ConvexError(`Chat tabs are limited to ${MAX_CHAT_TABS}`);
    }
    let count = (await ctx.db.query("chatTabs").take(MAX_CHAT_TABS)).length;
    for (const candidate of tabs) {
      const normalized = validateTab(candidate);
      if (await findTab(ctx, normalized.id)) continue;
      if (count >= MAX_CHAT_TABS) break;
      const now = Date.now();
      const tabId = await ctx.db.insert("chatTabs", {
        clientId: normalized.id,
        name: normalized.name,
        layout: normalized.layout,
        match: normalized.match,
        rules: normalized.rules,
        revision: 1,
        indexStatus: "building",
        createdAt: now,
        updatedAt: now,
      });
      await scheduleRebuild(ctx, tabId, 1);
      count += 1;
    }
    return null;
  },
});

export const remove = mutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const tab = await findTab(ctx, id);
    if (!tab) return null;
    await ctx.db.delete(tab._id);
    await ctx.scheduler.runAfter(0, anyApi.chatTabs.cleanupIndexBatch, {
      tabId: tab._id,
    });
    return null;
  },
});

export const rebuildIndexBatch = internalMutation({
  args: {
    tabId: v.id("chatTabs"),
    revision: v.number(),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const tab = await ctx.db.get(args.tabId);
    if (!tab) {
      await ctx.scheduler.runAfter(0, anyApi.chatTabs.cleanupIndexBatch, {
        tabId: args.tabId,
      });
      return null;
    }
    if (tab.revision !== args.revision) return null;

    const page = await ctx.db
      .query("chatMessages")
      .withIndex("by_timestamp")
      .order("asc")
      .paginate({ cursor: args.cursor, numItems: TAB_INDEX_BATCH_SIZE });
    const filter = tabAsMessageFilter(tab);
    await Promise.all(page.page
      .filter((message) => matchesMessageFilter(message, filter))
      .map((message) => ensureTabMatch(ctx, tab, message)));

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, anyApi.chatTabs.rebuildIndexBatch, {
        tabId: tab._id,
        revision: args.revision,
        cursor: page.continueCursor,
      });
      return null;
    }

    await ctx.db.patch(tab._id, {
      indexedRevision: args.revision,
      indexStatus: "ready",
      updatedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, anyApi.chatTabs.cleanupIndexBatch, {
      tabId: tab._id,
      keepRevision: args.revision,
    });
    return null;
  },
});

export const cleanupIndexBatch = internalMutation({
  args: {
    tabId: v.id("chatTabs"),
    keepRevision: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("chatTabMatches")
      .withIndex("by_tab_revision_timestamp", (q) => q.eq("tabId", args.tabId))
      .order("asc")
      .take(TAB_INDEX_BATCH_SIZE);
    const obsolete = args.keepRevision === undefined
      ? rows
      : rows.filter((row) => row.revision !== args.keepRevision);
    await Promise.all(obsolete.map((row) => ctx.db.delete(row._id)));
    if (obsolete.length > 0) {
      await ctx.scheduler.runAfter(0, anyApi.chatTabs.cleanupIndexBatch, args);
    }
    return null;
  },
});

export async function indexMessageForTabs(
  ctx: MutationCtx,
  message: Doc<"chatMessages">,
) {
  const tabs = await ctx.db.query("chatTabs").take(MAX_CHAT_TABS);
  await Promise.all(tabs
    .filter((tab) => matchesMessageFilter(message, tabAsMessageFilter(tab)))
    .map((tab) => ensureTabMatch(ctx, tab, message)));
}

export async function findTabByClientId(ctx: QueryCtx, clientId: string) {
  return findTab(ctx, clientId);
}

export async function loadIndexedTabMessages(
  ctx: QueryCtx,
  options: {
    tab: Doc<"chatTabs">;
    revision: number;
    paginationOpts: PaginationOptions;
    channelId?: Id<"channels">;
    afterTimestamp?: number;
    imagesOnly: boolean;
  },
): Promise<PaginationResult<Doc<"chatMessages">>> {
  const { tab, revision, paginationOpts, channelId, afterTimestamp, imagesOnly } = options;
  const matchPage = imagesOnly
    ? channelId
      ? await ctx.db
          .query("chatTabMatches")
          .withIndex("by_tab_revision_channel_images_timestamp", (q) => {
            const range = q
              .eq("tabId", tab._id)
              .eq("revision", revision)
              .eq("channelId", channelId)
              .eq("hasImages", true);
            return afterTimestamp ? range.gt("timestamp", afterTimestamp) : range;
          })
          .order("desc")
          .paginate(paginationOpts)
      : await ctx.db
          .query("chatTabMatches")
          .withIndex("by_tab_revision_images_timestamp", (q) => {
            const range = q
              .eq("tabId", tab._id)
              .eq("revision", revision)
              .eq("hasImages", true);
            return afterTimestamp ? range.gt("timestamp", afterTimestamp) : range;
          })
          .order("desc")
          .paginate(paginationOpts)
    : channelId
      ? await ctx.db
          .query("chatTabMatches")
          .withIndex("by_tab_revision_channel_timestamp", (q) => {
            const range = q
              .eq("tabId", tab._id)
              .eq("revision", revision)
              .eq("channelId", channelId);
            return afterTimestamp ? range.gt("timestamp", afterTimestamp) : range;
          })
          .order("desc")
          .paginate(paginationOpts)
      : await ctx.db
          .query("chatTabMatches")
          .withIndex("by_tab_revision_timestamp", (q) => {
            const range = q.eq("tabId", tab._id).eq("revision", revision);
            return afterTimestamp ? range.gt("timestamp", afterTimestamp) : range;
          })
          .order("desc")
          .paginate(paginationOpts);
  const messages = await Promise.all(matchPage.page.map((row) => ctx.db.get(row.messageId)));
  return {
    ...matchPage,
    page: messages.filter((message): message is Doc<"chatMessages"> => message !== null),
  };
}

export function tabConditionsKey(tab: Pick<ChatTabInput, "match" | "rules">) {
  return JSON.stringify({ match: tab.match, rules: tab.rules });
}

function validateTab(tab: ChatTabInput): ChatTabInput {
  const name = tab.name.trim();
  if (!tab.id || tab.id.length > 100 || !name || name.length > 40 || tab.rules.length === 0) {
    throw new ConvexError("Invalid chat tab");
  }
  const filter = tabAsMessageFilter({ ...tab, name });
  validateMessageCriteria({ filters: [filter] });
  return { ...tab, name };
}

export function tabAsMessageFilter(
  tab: Pick<ChatTabInput, "id" | "name" | "match" | "rules"> | Doc<"chatTabs">,
): MessageFilter {
  return {
    id: "clientId" in tab ? tab.clientId : tab.id,
    name: tab.name,
    action: "show",
    match: tab.match,
    rules: tab.rules,
  };
}

async function findTab(
  ctx: Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">,
  clientId: string,
) {
  return ctx.db
    .query("chatTabs")
    .withIndex("by_client_id", (q) => q.eq("clientId", clientId))
    .unique();
}

async function scheduleRebuild(
  ctx: MutationCtx,
  tabId: Id<"chatTabs">,
  revision: number,
) {
  await ctx.scheduler.runAfter(0, anyApi.chatTabs.rebuildIndexBatch, {
    tabId,
    revision,
    cursor: null,
  });
}

async function ensureTabMatch(
  ctx: MutationCtx,
  tab: Doc<"chatTabs">,
  message: Doc<"chatMessages">,
) {
  const existing = await ctx.db
    .query("chatTabMatches")
    .withIndex("by_tab_revision_message", (q) => q
      .eq("tabId", tab._id)
      .eq("revision", tab.revision)
      .eq("messageId", message._id))
    .unique();
  if (existing) return;
  await ctx.db.insert("chatTabMatches", {
    tabId: tab._id,
    revision: tab.revision,
    messageId: message._id,
    channelId: message.channelId,
    timestamp: message.timestamp,
    hasImages: message.hasImages ?? extractImageUrls(message.messageText).length > 0,
  });
}

function toClientTab(tab: Doc<"chatTabs">) {
  return {
    id: tab.clientId,
    name: tab.name,
    layout: tab.layout,
    match: tab.match,
    rules: tab.rules,
    revision: tab.revision,
    indexedRevision: tab.indexedRevision,
    indexStatus: tab.indexStatus,
  };
}

export function tabMatchesMessage(tab: ChatTabInput, message: FilterableMessage) {
  return matchesMessageFilter(message, tabAsMessageFilter(tab));
}
