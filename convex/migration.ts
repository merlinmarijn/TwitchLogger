import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { query } from "./functions";
import { requireIngestionSecret } from "./lib/ingestionAuth";

const tableValidator = v.union(
  v.literal("platforms"),
  v.literal("channels"),
  v.literal("chatTabs"),
  v.literal("chatMessages"),
  v.literal("chatTabMatches"),
  v.literal("adminSettings"),
  v.literal("adminJobs"),
  v.literal("adminMetrics"),
  v.literal("adminDatabaseStats"),
  v.literal("maintenanceThrottle"),
  v.literal("adminAuditLog"),
);

/**
 * Read one stable, bounded page for the PostgreSQL migration tool. Keep this
 * function deployed until the final Convex decommission so the migration can
 * be safely rerun to pick up late writes.
 */
export const exportPage = query({
  args: {
    ingestionSecret: v.string(),
    table: tableValidator,
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    requireIngestionSecret(args.ingestionSecret);
    if (args.paginationOpts.numItems < 1 || args.paginationOpts.numItems > 500) {
      throw new ConvexError("Migration pages are limited to 500 documents");
    }
    switch (args.table) {
      case "platforms": return ctx.db.query("platforms").order("asc").paginate(args.paginationOpts);
      case "channels": return ctx.db.query("channels").order("asc").paginate(args.paginationOpts);
      case "chatTabs": return ctx.db.query("chatTabs").order("asc").paginate(args.paginationOpts);
      case "chatMessages": return ctx.db.query("chatMessages").order("asc").paginate(args.paginationOpts);
      case "chatTabMatches": return ctx.db.query("chatTabMatches").order("asc").paginate(args.paginationOpts);
      case "adminSettings": return ctx.db.query("adminSettings").order("asc").paginate(args.paginationOpts);
      case "adminJobs": return ctx.db.query("adminJobs").order("asc").paginate(args.paginationOpts);
      case "adminMetrics": return ctx.db.query("adminMetrics").order("asc").paginate(args.paginationOpts);
      case "adminDatabaseStats": return ctx.db.query("adminDatabaseStats").order("asc").paginate(args.paginationOpts);
      case "maintenanceThrottle": return ctx.db.query("maintenanceThrottle").order("asc").paginate(args.paginationOpts);
      case "adminAuditLog": return ctx.db.query("adminAuditLog").order("asc").paginate(args.paginationOpts);
    }
  },
});
