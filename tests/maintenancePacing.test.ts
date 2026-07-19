import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimMaintenanceSlot,
  MAINTENANCE_BATCH_DELAY_MS,
  MAINTENANCE_READ_BATCH_SIZE,
  MAINTENANCE_WRITE_BATCH_SIZE,
} from "../convex/lib/maintenancePacing";

describe("maintenance database pacing", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps write batches smaller than scans and yields between batches", () => {
    expect(MAINTENANCE_WRITE_BATCH_SIZE).toBeGreaterThan(0);
    expect(MAINTENANCE_WRITE_BATCH_SIZE).toBeLessThan(MAINTENANCE_READ_BATCH_SIZE);
    expect(MAINTENANCE_READ_BATCH_SIZE).toBeLessThanOrEqual(100);
    expect(MAINTENANCE_BATCH_DELAY_MS).toBeGreaterThanOrEqual(250);
  });

  it("claims an available global background-work slot", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const insert = vi.fn().mockResolvedValue("throttle-id");
    const replace = vi.fn();
    const ctx = maintenanceContext(undefined, insert, replace);

    await expect(claimMaintenanceSlot(ctx)).resolves.toBe(0);
    expect(insert).toHaveBeenCalledWith("maintenanceThrottle", {
      key: "background-database-work",
      nextBatchAt: 1_000 + MAINTENANCE_BATCH_DELAY_MS,
      updatedAt: 1_000,
    });
    expect(replace).not.toHaveBeenCalled();
  });

  it("defers overlapping background work without writing", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const insert = vi.fn();
    const replace = vi.fn();
    const ctx = maintenanceContext({ nextBatchAt: 1_175 }, insert, replace);

    await expect(claimMaintenanceSlot(ctx)).resolves.toBe(175);
    expect(insert).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });
});

function maintenanceContext(existing: unknown, insert: ReturnType<typeof vi.fn>, replace: ReturnType<typeof vi.fn>) {
  return {
    db: {
      query: vi.fn(() => ({
        withIndex: vi.fn(() => ({ unique: vi.fn().mockResolvedValue(existing) })),
      })),
      insert,
      replace,
    },
  } as never;
}
