import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../db/migrations",
);

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

async function applyMigration(client: PoolClient, version: string) {
  const applied = await client.query(
    "SELECT 1 FROM schema_migrations WHERE version = $1",
    [version],
  );
  if (applied.rowCount) return;
  const sql = await readFile(resolve(migrationsDirectory, version), "utf8");
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
