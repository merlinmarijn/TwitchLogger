import type { MutationCtx } from "../_generated/server";

/**
 * Keep background database work small and leave time for ingestion and UI
 * requests between batches. Read-only scans can safely use larger pages, while
 * jobs that update derived data stay deliberately conservative.
 */
export const MAINTENANCE_WRITE_BATCH_SIZE = 20;
export const MAINTENANCE_READ_BATCH_SIZE = 100;
export const MAINTENANCE_BATCH_DELAY_MS = 250;

const THROTTLE_KEY = "background-database-work";

/**
 * Serialize otherwise independent background chains through one small document.
 * Normal queries and ingestion mutations never touch it, so they remain free to
 * run between maintenance batches.
 */
export async function claimMaintenanceSlot(ctx: MutationCtx) {
  const now = Date.now();
  const throttle = await ctx.db
    .query("maintenanceThrottle")
    .withIndex("by_key", (q) => q.eq("key", THROTTLE_KEY))
    .unique();
  if (throttle && throttle.nextBatchAt > now) {
    return throttle.nextBatchAt - now;
  }

  const value = {
    key: THROTTLE_KEY,
    nextBatchAt: now + MAINTENANCE_BATCH_DELAY_MS,
    updatedAt: now,
  };
  if (throttle) await ctx.db.replace(throttle._id, value);
  else await ctx.db.insert("maintenanceThrottle", value);
  return 0;
}
