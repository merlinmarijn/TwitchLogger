import { paginationOptsValidator } from "convex/server";
import { ConvexError, getDocumentSize, type Value, v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalMutation, internalQuery, query } from "./functions";
import { requireIngestionSecret } from "./lib/ingestionAuth";
import {
  claimMaintenanceSlot,
  MAINTENANCE_READ_BATCH_SIZE,
} from "./lib/maintenancePacing";

const tableValidator = v.union(
  v.literal("platforms"),
  v.literal("channels"),
  v.literal("chatMessages"),
);

const applicationTables = ["platforms", "channels", "chatMessages"] as const;

type ApplicationTable = (typeof applicationTables)[number];

type PageMeasurements = {
  count: number;
  documentBytes: number;
  largestDocumentBytes: number;
  oldestCreationTime: number | null;
  newestCreationTime: number | null;
  continueCursor: string;
  isDone: boolean;
};

type TableMeasurements = Omit<PageMeasurements, "continueCursor" | "isDone"> & {
  table: ApplicationTable;
  averageDocumentBytes: number;
  formattedDocumentBytes: string;
};

type DatabaseMeasurements = {
  generatedAt: number;
  documentCount: number;
  documentBytes: number;
  formattedDocumentBytes: string;
  largestDocumentBytes: number;
  tables: TableMeasurements[];
  scope: string;
};

const connectionStatuses = [
  "disconnected",
  "connecting",
  "connected",
  "error",
  "authorization_required",
] as const;

type ConnectionStatus = (typeof connectionStatuses)[number];

function formatBytes(bytes: number) {
  if (bytes < 1_000) return `${bytes} B`;

  const units = ["kB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = -1;
  do {
    value /= 1_000;
    unitIndex += 1;
  } while (value >= 1_000 && unitIndex < units.length - 1);

  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

/**
 * Read one bounded page and calculate its Convex document payload size.
 * The public action calls this repeatedly so large databases do not need to
 * fit within one query transaction.
 */
export const measureTablePage = internalQuery({
  args: {
    table: tableValidator,
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args): Promise<PageMeasurements> => {
    const result =
      args.table === "platforms"
        ? await ctx.db.query("platforms").paginate(args.paginationOpts)
        : args.table === "channels"
          ? await ctx.db.query("channels").paginate(args.paginationOpts)
          : await ctx.db.query("chatMessages").paginate(args.paginationOpts);

    let documentBytes = 0;
    let largestDocumentBytes = 0;
    let oldestCreationTime: number | null = null;
    let newestCreationTime: number | null = null;

    for (const document of result.page) {
      const size = getDocumentSize(document as Record<string, Value>);
      documentBytes += size;
      largestDocumentBytes = Math.max(largestDocumentBytes, size);
      oldestCreationTime =
        oldestCreationTime === null
          ? document._creationTime
          : Math.min(oldestCreationTime, document._creationTime);
      newestCreationTime =
        newestCreationTime === null
          ? document._creationTime
          : Math.max(newestCreationTime, document._creationTime);
    }

    return {
      count: result.page.length,
      documentBytes,
      largestDocumentBytes,
      oldestCreationTime,
      newestCreationTime,
      continueCursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
});

export const claimDatabaseStatsSlot = internalMutation({
  args: {},
  handler: claimMaintenanceSlot,
});

/**
 * Scan every application table and report document counts and payload sizes.
 * This is an action because a single Convex query can only paginate once.
 */
export const databaseStats = action({
  args: {
    ingestionSecret: v.string(),
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<DatabaseMeasurements> => {
    requireIngestionSecret(args.ingestionSecret);
    const pageSize = Math.max(
      1,
      Math.min(Math.floor(args.pageSize ?? MAINTENANCE_READ_BATCH_SIZE), MAINTENANCE_READ_BATCH_SIZE),
    );
    const tables: TableMeasurements[] = [];

    for (const table of applicationTables) {
      let cursor: string | null = null;
      let isDone = false;
      let count = 0;
      let documentBytes = 0;
      let largestDocumentBytes = 0;
      let oldestCreationTime: number | null = null;
      let newestCreationTime: number | null = null;

      while (!isDone) {
        let waitMs = await ctx.runMutation(internal.debug.claimDatabaseStatsSlot, {});
        while (waitMs > 0) {
          await pause(waitMs);
          waitMs = await ctx.runMutation(internal.debug.claimDatabaseStatsSlot, {});
        }
        const page: PageMeasurements = await ctx.runQuery(
          internal.debug.measureTablePage,
          {
            table,
            paginationOpts: { cursor, numItems: pageSize },
          },
        );

        count += page.count;
        documentBytes += page.documentBytes;
        largestDocumentBytes = Math.max(
          largestDocumentBytes,
          page.largestDocumentBytes,
        );
        if (page.oldestCreationTime !== null) {
          oldestCreationTime =
            oldestCreationTime === null
              ? page.oldestCreationTime
              : Math.min(oldestCreationTime, page.oldestCreationTime);
        }
        if (page.newestCreationTime !== null) {
          newestCreationTime =
            newestCreationTime === null
              ? page.newestCreationTime
              : Math.max(newestCreationTime, page.newestCreationTime);
        }

        cursor = page.continueCursor;
        isDone = page.isDone;
      }

      tables.push({
        table,
        count,
        documentBytes,
        formattedDocumentBytes: formatBytes(documentBytes),
        averageDocumentBytes: count === 0 ? 0 : Math.round(documentBytes / count),
        largestDocumentBytes,
        oldestCreationTime,
        newestCreationTime,
      });
    }

    const documentCount = tables.reduce((total, table) => total + table.count, 0);
    const documentBytes = tables.reduce(
      (total, table) => total + table.documentBytes,
      0,
    );

    return {
      generatedAt: Date.now(),
      documentCount,
      documentBytes,
      formattedDocumentBytes: formatBytes(documentBytes),
      largestDocumentBytes: Math.max(
        0,
        ...tables.map((table) => table.largestDocumentBytes),
      ),
      tables,
      scope:
        "All application document payloads. Convex indexes, backups, logs, and platform overhead are not exposed through database queries and are not included.",
    };
  },
});

function pause(durationMs: number) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

/** Return a compact operational snapshot without scanning the message table. */
export const health = query({
  args: {
    ingestionSecret: v.string(),
    staleAfterMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireIngestionSecret(args.ingestionSecret);
    const now = Date.now();
    const staleAfterMs = Math.max(0, args.staleAfterMs ?? 15 * 60 * 1_000);
    const [platforms, channels, latestMessage] = await Promise.all([
      ctx.db.query("platforms").collect(),
      ctx.db.query("channels").collect(),
      ctx.db.query("chatMessages").withIndex("by_timestamp").order("desc").first(),
    ]);

    const byConnectionStatus = Object.fromEntries(
      connectionStatuses.map((status) => [status, 0]),
    ) as Record<(typeof connectionStatuses)[number], number>;
    for (const channel of channels) {
      byConnectionStatus[channel.connectionStatus as ConnectionStatus] += 1;
    }

    const activeChannels = channels.filter((channel) => channel.hiddenAt === undefined);
    const loggingChannels = activeChannels.filter((channel) => channel.loggingEnabled);
    const problemChannels = loggingChannels
      .filter(
        (channel) =>
          channel.connectionStatus === "error" ||
          channel.connectionStatus === "authorization_required" ||
          channel.externalChannelId === undefined ||
          channel.lastMessageAt === undefined ||
          now - channel.lastMessageAt > staleAfterMs,
      )
      .map((channel) => ({
        id: channel._id,
        username: channel.username,
        connectionStatus: channel.connectionStatus,
        connectionError: channel.connectionError,
        resolved: channel.externalChannelId !== undefined,
        lastConnectedAt: channel.lastConnectedAt,
        lastMessageAt: channel.lastMessageAt,
        stale:
          channel.lastMessageAt === undefined ||
          now - channel.lastMessageAt > staleAfterMs,
      }));

    return {
      generatedAt: now,
      status: problemChannels.length === 0 ? "healthy" : "attention_required",
      platforms: {
        total: platforms.length,
        enabled: platforms.filter((platform) => platform.enabled).length,
        values: platforms.map(({ name, slug, enabled }) => ({ name, slug, enabled })),
      },
      channels: {
        total: channels.length,
        active: activeChannels.length,
        hidden: channels.length - activeChannels.length,
        loggingEnabled: loggingChannels.length,
        byConnectionStatus,
        problemChannels,
      },
      messages: {
        latest: latestMessage
          ? {
              id: latestMessage._id,
              externalMessageId: latestMessage.externalMessageId,
              channelId: latestMessage.channelId,
              channelName: latestMessage.channelName,
              senderUsername: latestMessage.senderUsername,
              timestamp: latestMessage.timestamp,
              ageMs: Math.max(0, now - latestMessage.timestamp),
            }
          : null,
      },
      staleAfterMs,
    };
  },
});

/**
 * Look up ingestion identifiers through both unique-candidate indexes. Returning
 * multiple matches makes accidental duplicate ingestion immediately visible.
 */
export const findMessage = query({
  args: {
    ingestionSecret: v.string(),
    externalMessageId: v.optional(v.string()),
    eventNotificationId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireIngestionSecret(args.ingestionSecret);
    if (!args.externalMessageId && !args.eventNotificationId) {
      throw new ConvexError(
        "Provide externalMessageId, eventNotificationId, or both",
      );
    }

    const [externalMessageMatches, eventNotificationMatches] = await Promise.all([
      args.externalMessageId
        ? ctx.db
            .query("chatMessages")
            .withIndex("by_external_message", (q) =>
              q.eq("externalMessageId", args.externalMessageId!),
            )
            .take(10)
        : Promise.resolve([]),
      args.eventNotificationId
        ? ctx.db
            .query("chatMessages")
            .withIndex("by_event_notification", (q) =>
              q.eq("eventNotificationId", args.eventNotificationId!),
            )
            .take(10)
        : Promise.resolve([]),
    ]);

    return {
      externalMessageId: args.externalMessageId
        ? {
            value: args.externalMessageId,
            matches: externalMessageMatches,
            duplicate: externalMessageMatches.length > 1,
            truncated: externalMessageMatches.length === 10,
          }
        : null,
      eventNotificationId: args.eventNotificationId
        ? {
            value: args.eventNotificationId,
            matches: eventNotificationMatches,
            duplicate: eventNotificationMatches.length > 1,
            truncated: eventNotificationMatches.length === 10,
          }
        : null,
    };
  },
});
