import { ConvexError, v } from "convex/values";
import { mutation, query } from "./functions";
import { requireIngestionSecret } from "./lib/ingestionAuth";

const twitchLoginPattern = /^[a-z0-9_]{1,25}$/;

export const list = query({
  args: {},
  handler: async (ctx) => {
    const channels = await ctx.db.query("channels").order("asc").collect();
    return channels.filter((channel) => channel.hiddenAt === undefined);
  },
});

export const listLogging = query({
  args: {},
  handler: async (ctx) =>
    ctx.db
      .query("channels")
      .withIndex("by_logging", (q) => q.eq("loggingEnabled", true))
      .collect(),
});

export const add = mutation({
  args: {
    platform: v.literal("twitch"),
    username: v.string(),
    displayName: v.optional(v.string()),
    loggingEnabled: v.boolean(),
  },
  handler: async (ctx, args) => {
    const username = args.username.trim().toLowerCase().replace(/^@/, "");
    if (!twitchLoginPattern.test(username)) {
      throw new ConvexError("Enter a valid Twitch username");
    }

    const existing = await ctx.db
      .query("channels")
      .withIndex("by_platform_username", (q) => q.eq("platform", args.platform))
      .filter((q) => q.eq(q.field("username"), username))
      .unique();
    if (existing) {
      if (existing.hiddenAt === undefined) {
        throw new ConvexError("That channel is already followed");
      }

      await ctx.db.patch(existing._id, {
        displayName: args.displayName?.trim() || existing.displayName,
        loggingEnabled: args.loggingEnabled,
        connectionStatus: args.loggingEnabled ? "connecting" : "disconnected",
        connectionError: undefined,
        hiddenAt: undefined,
        updatedAt: Date.now(),
      });
      return existing._id;
    }

    const now = Date.now();
    return ctx.db.insert("channels", {
      platform: args.platform,
      username,
      displayName: args.displayName?.trim() || username,
      loggingEnabled: args.loggingEnabled,
      connectionStatus: args.loggingEnabled ? "connecting" : "disconnected",
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const setLogging = mutation({
  args: { id: v.id("channels"), enabled: v.boolean() },
  handler: async (ctx, args) => {
    const channel = await ctx.db.get(args.id);
    if (!channel) throw new ConvexError("Channel not found");
    await ctx.db.patch(args.id, {
      loggingEnabled: args.enabled,
      connectionStatus: args.enabled ? "connecting" : "disconnected",
      connectionError: undefined,
      updatedAt: Date.now(),
    });
  },
});

export const reconnect = mutation({
  args: { id: v.id("channels") },
  handler: async (ctx, args) => {
    const channel = await ctx.db.get(args.id);
    if (!channel) throw new ConvexError("Channel not found");
    await ctx.db.patch(args.id, {
      loggingEnabled: true,
      connectionStatus: "connecting",
      connectionError: undefined,
      updatedAt: Date.now(),
    });
  },
});

export const remove = mutation({
  args: { id: v.id("channels") },
  handler: async (ctx, args) => {
    const channel = await ctx.db.get(args.id);
    if (!channel) throw new ConvexError("Channel not found");
    await ctx.db.patch(args.id, {
      hiddenAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});

export const updateResolved = mutation({
  args: {
    ingestionSecret: v.string(),
    id: v.id("channels"),
    externalChannelId: v.string(),
    username: v.string(),
    displayName: v.string(),
  },
  handler: async (ctx, args) => {
    requireIngestionSecret(args.ingestionSecret);
    await ctx.db.patch(args.id, {
      externalChannelId: args.externalChannelId,
      username: args.username,
      displayName: args.displayName,
      updatedAt: Date.now(),
    });
  },
});

export const updateConnectionStatus = mutation({
  args: {
    ingestionSecret: v.string(),
    id: v.id("channels"),
    status: v.union(
      v.literal("disconnected"),
      v.literal("connecting"),
      v.literal("connected"),
      v.literal("error"),
      v.literal("authorization_required"),
    ),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireIngestionSecret(args.ingestionSecret);
    await ctx.db.patch(args.id, {
      connectionStatus: args.status,
      connectionError: args.error,
      ...(args.status === "connected" ? { lastConnectedAt: Date.now() } : {}),
      updatedAt: Date.now(),
    });
  },
});
