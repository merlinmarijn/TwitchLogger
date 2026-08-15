import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { applyMigration } from "../worker/database";

describe("PostgreSQL migration retries", () => {
  it.each(["40P01", "55P03"])("retries transaction error %s", async (code) => {
    let migrationAttempts = 0;
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (text: string) => {
        queries.push(text);
        if (text.startsWith("SELECT 1 FROM schema_migrations")) {
          return { rowCount: 0, rows: [] };
        }
        if (text.includes("CREATE TABLE IF NOT EXISTS platforms")) {
          migrationAttempts += 1;
          if (migrationAttempts === 1) throw Object.assign(new Error("retry"), { code });
        }
        return { rowCount: 1, rows: [] };
      }),
    } as unknown as PoolClient;

    await applyMigration(client, "001_initial.sql", async () => undefined);

    expect(queries.filter((query) => query === "BEGIN")).toHaveLength(2);
    expect(queries.filter((query) => query === "ROLLBACK")).toHaveLength(1);
    expect(queries.filter((query) => query === "COMMIT")).toHaveLength(1);
    expect(queries.filter((query) => query.startsWith("SET LOCAL"))).toHaveLength(2);
  });
});
