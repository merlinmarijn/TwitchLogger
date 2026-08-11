import { createHash } from "node:crypto";
import { createClient } from "@clickhouse/client";
import type { PoolClient } from "pg";
import type { LoadedConfiguration } from "./config";
import type { PostgresDatabase } from "./database";
import type { Logger } from "./logger";

const MIRROR_LOCK_ID = 1_987_042_019;
const SCHEMA_REFRESH_MS = 60_000;
const RETRY_INTERVAL_MS = 5_000;
const CONTROL_TABLES = new Set([
  "clickhouse_mirror_outbox",
  "clickhouse_mirror_state",
]);

type ClickHouseOptions = NonNullable<LoadedConfiguration["clickHouseOptions"]>;

interface ColumnRow {
  table_name: string;
  column_name: string;
  ordinal_position: number;
  is_nullable: "YES" | "NO";
  data_type: string;
  udt_name: string;
  numeric_precision: number | null;
  numeric_scale: number | null;
  primary_key_position: number;
}

export interface MirrorColumn {
  name: string;
  postgresType: string;
  clickHouseType: string;
  nullable: boolean;
  primaryKeyPosition: number;
}

interface MirrorTable {
  name: string;
  columns: MirrorColumn[];
  primaryKey: MirrorColumn[];
  schemaSignature: string;
}

interface OutboxRow {
  source_table: string;
  primary_key: Record<string, unknown>;
  version: string;
  operation: "upsert" | "delete";
}

export class ClickHouseMirrorService {
  private readonly clickHouse: ReturnType<typeof createClient>;
  private stopped = false;
  private task?: Promise<void>;
  private wake?: () => void;
  private lockClient?: PoolClient;

  constructor(
    private readonly database: PostgresDatabase,
    private readonly options: ClickHouseOptions,
    private readonly logger: Logger,
  ) {
    this.clickHouse = createClient({
      url: options.url,
      database: options.database,
      username: options.username,
      password: options.password,
      application: "twitch-logs-postgres-mirror",
      clickhouse_settings: {
        async_insert: 1,
        wait_for_async_insert: 1,
      },
    });
  }

  start() {
    if (!this.task) this.task = this.run();
  }

  async stop() {
    this.stopped = true;
    this.wake?.();
    await this.task;
    await this.clickHouse.close();
  }

  private async run() {
    while (!this.stopped) {
      try {
        const ping = await this.clickHouse.ping();
        if (!ping.success) throw ping.error ?? new Error("ClickHouse ping failed");
        const leader = await this.acquireLeadership();
        if (!leader) {
          await this.sleep(RETRY_INTERVAL_MS);
          continue;
        }

        this.logger.info(
          { clickHouseDatabase: this.options.database },
          "ClickHouse mirror became the active replica",
        );
        let tables = await this.synchronizeSchemasAndBackfill();
        let refreshAt = Date.now() + SCHEMA_REFRESH_MS;

        while (!this.stopped) {
          if (Date.now() >= refreshAt) {
            tables = await this.synchronizeSchemasAndBackfill();
            refreshAt = Date.now() + SCHEMA_REFRESH_MS;
          }
          const mirrored = await this.mirrorOutbox(tables);
          if (mirrored === 0) await this.sleep(this.options.pollIntervalMs);
        }
      } catch (error) {
        if (!this.stopped) {
          this.logger.warn(
            { err: error },
            "ClickHouse mirroring failed; PostgreSQL remains active and mirroring will retry",
          );
          await this.sleep(RETRY_INTERVAL_MS);
        }
      } finally {
        await this.releaseLeadership();
      }
    }
  }

  private async acquireLeadership() {
    this.lockClient = await this.database.pool.connect();
    const result = await this.lockClient.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [MIRROR_LOCK_ID],
    );
    if (result.rows[0]?.acquired) return true;
    this.lockClient.release();
    this.lockClient = undefined;
    return false;
  }

  private async releaseLeadership() {
    if (!this.lockClient) return;
    await this.lockClient
      .query("SELECT pg_advisory_unlock($1)", [MIRROR_LOCK_ID])
      .catch(() => undefined);
    this.lockClient.release();
    this.lockClient = undefined;
  }

  private async synchronizeSchemasAndBackfill() {
    const client = this.requireLockClient();
    await client.query("SELECT ensure_clickhouse_mirror_triggers()");
    const tables = await discoverTables(client);
    for (const table of tables.values()) {
      await this.ensureClickHouseTable(table);
      const state = await client.query<{ schema_signature: string }>(
        `SELECT schema_signature
         FROM clickhouse_mirror_state
         WHERE source_table = $1`,
        [table.name],
      );
      if (state.rows[0]?.schema_signature !== table.schemaSignature) {
        await this.backfillTable(client, table);
      }
    }
    return tables;
  }

  private async ensureClickHouseTable(table: MirrorTable) {
    const columnSql = table.columns
      .map((column) => `${quoteClickHouseIdentifier(column.name)} ${column.clickHouseType}`)
      .join(",\n  ");
    const orderBy = table.primaryKey
      .map((column) => quoteClickHouseIdentifier(column.name))
      .join(", ");
    await this.clickHouse.command({
      query: `
        CREATE TABLE IF NOT EXISTS ${this.clickHouseTable(table.name)} (
          ${columnSql},
          \`_mirror_version\` UInt64,
          \`_mirror_deleted\` Bool DEFAULT false,
          \`_mirror_synced_at\` DateTime64(3, 'UTC') DEFAULT now64(3)
        )
        ENGINE = ReplacingMergeTree(_mirror_version)
        ORDER BY (${orderBy})
      `,
    });

    for (const column of table.columns) {
      await this.clickHouse.command({
        query: `ALTER TABLE ${this.clickHouseTable(table.name)} ` +
          `ADD COLUMN IF NOT EXISTS ${quoteClickHouseIdentifier(column.name)} ` +
          column.clickHouseType,
      });
    }
  }

  private async backfillTable(client: PoolClient, table: MirrorTable) {
    const versionResult = await client.query<{ version: string }>(
      "SELECT nextval('clickhouse_mirror_version_seq')::text AS version",
    );
    const version = versionResult.rows[0].version;
    let lastKey: unknown[] | undefined;
    let mirrored = 0;

    this.logger.info({ table: table.name }, "Backfilling PostgreSQL table into ClickHouse");
    while (!this.stopped) {
      const values = lastKey ? [...lastKey, this.options.batchSize] : [this.options.batchSize];
      const keyColumns = table.primaryKey.map((column) => quotePostgresIdentifier(column.name));
      const where = lastKey
        ? `WHERE (${keyColumns.join(", ")}) > (` +
          lastKey.map((_, index) => `$${index + 1}`).join(", ") + ")"
        : "";
      const result = await client.query<Record<string, unknown>>(
        `SELECT * FROM public.${quotePostgresIdentifier(table.name)}
         ${where}
         ORDER BY ${keyColumns.join(", ")}
         LIMIT $${values.length}`,
        values,
      );
      if (result.rows.length === 0) break;

      await this.insertRows(table, result.rows.map((row) => ({
        ...serializeRow(table, row),
        _mirror_version: version,
        _mirror_deleted: false,
        _mirror_synced_at: clickHouseTimestamp(new Date()),
      })));
      mirrored += result.rows.length;
      const finalRow = result.rows.at(-1)!;
      lastKey = table.primaryKey.map((column) => finalRow[column.name]);
    }

    await client.query(
      `INSERT INTO clickhouse_mirror_state (
         source_table, schema_signature, backfill_version, backfilled_at
       ) VALUES ($1, $2, $3, now())
       ON CONFLICT (source_table) DO UPDATE
       SET schema_signature = EXCLUDED.schema_signature,
           backfill_version = EXCLUDED.backfill_version,
           backfilled_at = EXCLUDED.backfilled_at`,
      [table.name, table.schemaSignature, version],
    );
    // Replay even older versions: a transaction can allocate an outbox version
    // before this backfill and commit only after its row was scanned. The
    // ReplacingMergeTree version makes this replay idempotent and race-safe.
    this.logger.info({ table: table.name, rows: mirrored }, "ClickHouse backfill completed");
  }

  private async mirrorOutbox(tables: Map<string, MirrorTable>) {
    const client = this.requireLockClient();
    const result = await client.query<OutboxRow>(
      `SELECT source_table, primary_key, version::text, operation
       FROM clickhouse_mirror_outbox
       ORDER BY version
       LIMIT $1`,
      [this.options.batchSize],
    );
    if (result.rows.length === 0) return 0;

    const byTable = groupBy(result.rows, (row) => row.source_table);
    const completedVersions: string[] = [];
    for (const [tableName, changes] of byTable) {
      const table = tables.get(tableName);
      if (!table) throw new Error(`ClickHouse mirror schema is missing table ${tableName}`);
      const currentRows = await fetchChangedRows(client, table, changes);
      const byKey = new Map(
        currentRows.map((row) => [rowKey(table, row), row]),
      );
      const syncedAt = clickHouseTimestamp(new Date());
      const rows = changes.map((change) => {
        const current = byKey.get(rowKey(table, change.primary_key));
        if (change.operation === "delete" || !current) {
          return {
            ...serializePrimaryKey(table, change.primary_key),
            _mirror_version: change.version,
            _mirror_deleted: true,
            _mirror_synced_at: syncedAt,
          };
        }
        return {
          ...serializeRow(table, current),
          _mirror_version: change.version,
          _mirror_deleted: false,
          _mirror_synced_at: syncedAt,
        };
      });
      await this.insertRows(table, rows);
      completedVersions.push(...changes.map((change) => change.version));
    }

    await client.query(
      "DELETE FROM clickhouse_mirror_outbox WHERE version = ANY($1::bigint[])",
      [completedVersions],
    );
    this.logger.debug({ rows: result.rows.length }, "Mirrored PostgreSQL changes to ClickHouse");
    return result.rows.length;
  }

  private insertRows(table: MirrorTable, rows: Record<string, unknown>[]) {
    return this.clickHouse.insert({
      table: this.clickHouseTable(table.name),
      values: rows,
      format: "JSONEachRow",
      columns: [
        "_mirror_version",
        "_mirror_deleted",
        "_mirror_synced_at",
        ...table.columns.map((column) => column.name),
      ],
      clickhouse_settings: {
        input_format_defaults_for_omitted_fields: 1,
      },
    });
  }

  private clickHouseTable(tableName: string) {
    return `${quoteClickHouseIdentifier(this.options.database)}.${quoteClickHouseIdentifier(tableName)}`;
  }

  private requireLockClient() {
    if (!this.lockClient) throw new Error("ClickHouse mirror leadership was lost");
    return this.lockClient;
  }

  private sleep(milliseconds: number) {
    if (this.stopped) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.wake = undefined;
        resolve();
      }, milliseconds);
      this.wake = () => {
        clearTimeout(timeout);
        this.wake = undefined;
        resolve();
      };
    });
  }
}

async function discoverTables(client: PoolClient) {
  const result = await client.query<ColumnRow>(`
    WITH primary_keys AS (
      SELECT class.relname AS table_name,
             attribute.attname AS column_name,
             key_column.ordinality::integer AS primary_key_position
      FROM pg_class AS class
      JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
      JOIN pg_index AS index
        ON index.indrelid = class.oid AND index.indisprimary
      CROSS JOIN LATERAL unnest(index.indkey) WITH ORDINALITY
        AS key_column(attribute_number, ordinality)
      JOIN pg_attribute AS attribute
        ON attribute.attrelid = class.oid
        AND attribute.attnum = key_column.attribute_number
      WHERE namespace.nspname = 'public'
    )
    SELECT column_info.table_name,
           column_info.column_name,
           column_info.ordinal_position,
           column_info.is_nullable,
           column_info.data_type,
           column_info.udt_name,
           column_info.numeric_precision,
           column_info.numeric_scale,
           COALESCE(primary_keys.primary_key_position, 0) AS primary_key_position
    FROM information_schema.columns AS column_info
    JOIN information_schema.tables AS table_info
      ON table_info.table_schema = column_info.table_schema
      AND table_info.table_name = column_info.table_name
      AND table_info.table_type = 'BASE TABLE'
    LEFT JOIN primary_keys
      ON primary_keys.table_name = column_info.table_name
      AND primary_keys.column_name = column_info.column_name
    WHERE column_info.table_schema = 'public'
    ORDER BY column_info.table_name, column_info.ordinal_position
  `);

  const tables = new Map<string, MirrorTable>();
  for (const [tableName, rows] of groupBy(result.rows, (row) => row.table_name)) {
    if (CONTROL_TABLES.has(tableName)) continue;
    const columns = rows.map(toMirrorColumn);
    const primaryKey = columns
      .filter((column) => column.primaryKeyPosition > 0)
      .sort((left, right) => left.primaryKeyPosition - right.primaryKeyPosition);
    if (primaryKey.length === 0) continue;
    const schemaSignature = createHash("sha256")
      .update(JSON.stringify(columns))
      .digest("hex");
    tables.set(tableName, { name: tableName, columns, primaryKey, schemaSignature });
  }
  return tables;
}

async function fetchChangedRows(
  client: PoolClient,
  table: MirrorTable,
  changes: OutboxRow[],
) {
  const values: unknown[] = [];
  const conditions = changes.map((change) => {
    const comparisons = table.primaryKey.map((column) => {
      values.push(change.primary_key[column.name]);
      return `${quotePostgresIdentifier(column.name)} = $${values.length}`;
    });
    return `(${comparisons.join(" AND ")})`;
  });
  const result = await client.query<Record<string, unknown>>(
    `SELECT * FROM public.${quotePostgresIdentifier(table.name)}
     WHERE ${conditions.join(" OR ")}`,
    values,
  );
  return result.rows;
}

function toMirrorColumn(row: ColumnRow): MirrorColumn {
  const nullable = row.is_nullable === "YES";
  const postgresType = row.udt_name;
  let clickHouseType = mapPostgresType(row);
  if (nullable && !clickHouseType.startsWith("Array(")) {
    clickHouseType = `Nullable(${clickHouseType})`;
  }
  return {
    name: row.column_name,
    postgresType,
    clickHouseType,
    nullable,
    primaryKeyPosition: Number(row.primary_key_position),
  };
}

export function mapPostgresType(row: Pick<
  ColumnRow,
  "data_type" | "udt_name" | "numeric_precision" | "numeric_scale"
>) {
  if (row.data_type === "ARRAY") {
    const elementType = mapScalarPostgresType(row.udt_name.replace(/^_/, ""), null, null);
    return `Array(Nullable(${elementType}))`;
  }
  return mapScalarPostgresType(row.udt_name, row.numeric_precision, row.numeric_scale);
}

function mapScalarPostgresType(
  type: string,
  numericPrecision: number | null,
  numericScale: number | null,
) {
  switch (type) {
    case "bool": return "Bool";
    case "int2": return "Int16";
    case "int4": return "Int32";
    case "int8": return "Int64";
    case "float4": return "Float32";
    case "float8": return "Float64";
    case "uuid": return "UUID";
    case "date": return "Date32";
    case "timestamp": return "DateTime64(6)";
    case "timestamptz": return "DateTime64(6, 'UTC')";
    case "numeric": {
      if (numericPrecision === null || numericScale === null) return "String";
      const precision = Math.min(Math.max(numericPrecision, 1), 76);
      const scale = Math.min(Math.max(numericScale, 0), precision);
      return `Decimal(${precision}, ${scale})`;
    }
    default: return "String";
  }
}

function serializeRow(table: MirrorTable, row: Record<string, unknown>) {
  return Object.fromEntries(
    table.columns.map((column) => [
      column.name,
      serializeClickHouseValue(column, row[column.name]),
    ]),
  );
}

function serializePrimaryKey(table: MirrorTable, key: Record<string, unknown>) {
  return Object.fromEntries(
    table.primaryKey.map((column) => [
      column.name,
      serializeClickHouseValue(column, key[column.name]),
    ]),
  );
}

export function serializeClickHouseValue(column: MirrorColumn, value: unknown): unknown {
  if (value === null || value === undefined) {
    return column.clickHouseType.startsWith("Array(") ? [] : null;
  }
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (value instanceof Date) {
    return column.clickHouseType.includes("Date32")
      ? value.toISOString().slice(0, 10)
      : clickHouseTimestamp(value, true);
  }
  if (column.postgresType === "json" || column.postgresType === "jsonb") {
    return JSON.stringify(value);
  }
  return value;
}

function rowKey(table: MirrorTable, row: Record<string, unknown>) {
  return table.primaryKey
    .map((column) => `${column.name}:${String(row[column.name])}`)
    .join("\u0000");
}

function clickHouseTimestamp(value: Date, microseconds = false) {
  const iso = value.toISOString().replace("T", " ").replace("Z", "");
  return microseconds ? `${iso}000` : iso;
}

function quotePostgresIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteClickHouseIdentifier(value: string) {
  return `\`${value.replaceAll("`", "``")}\``;
}

function groupBy<T, K>(values: T[], keyFor: (value: T) => K) {
  const grouped = new Map<K, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    const group = grouped.get(key);
    if (group) group.push(value);
    else grouped.set(key, [value]);
  }
  return grouped;
}
