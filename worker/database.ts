import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../db/migrations",
);
const MAX_MIGRATION_ATTEMPTS = 5;
const RETRYABLE_MIGRATION_CODES = new Set(["40P01", "55P03"]);

export class PostgresDatabase {
  readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) {
    return this.pool.query<T>(text, values);
  }

  async migrate() {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1)", [1_987_042_018]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      const files = (await readdir(migrationsDirectory))
        .filter((file) => file.endsWith(".sql"))
        .sort();
      for (const file of files) await applyMigration(client, file);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [1_987_042_018]).catch(() => undefined);
      client.release();
    }
  }

  close() {
    return this.pool.end();
  }
}

export async function applyMigration(
  client: PoolClient,
  version: string,
  retryDelay: (milliseconds: number) => Promise<void> = waitForRetry,
) {
  const applied = await client.query(
    "SELECT 1 FROM schema_migrations WHERE version = $1",
    [version],
  );
  if (applied.rowCount) return;
  const sql = await readFile(resolve(migrationsDirectory, version), "utf8");
  for (let attempt = 1; attempt <= MAX_MIGRATION_ATTEMPTS; attempt += 1) {
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL lock_timeout = '30s'");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
      await client.query("COMMIT");
      return;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (!isRetryableMigrationError(error) || attempt === MAX_MIGRATION_ATTEMPTS) {
        throw error;
      }
      await retryDelay(250 * (2 ** (attempt - 1)));
    }
  }
}

function isRetryableMigrationError(error: unknown) {
  return Boolean(
    error && typeof error === "object" && "code" in error &&
    RETRYABLE_MIGRATION_CODES.has(String(error.code)),
  );
}

function waitForRetry(milliseconds: number) {
  return new Promise<void>((resolveRetry) => setTimeout(resolveRetry, milliseconds));
}
