# ClickHouse mirror

ClickHouse is an optional, write-only mirror for measuring compression and analytical query performance against the same data held in PostgreSQL. PostgreSQL remains the source of truth. The dashboard, API, ingestion, moderation, archive verification, and admin control room never read from ClickHouse.

## What is mirrored

The worker discovers every public PostgreSQL base table with a primary key, creates a typed ClickHouse table with the same name, and backfills all existing rows. This includes hot messages, cold archive chunks and indexes, channels, saved tabs, feedback, admin data, and migration history. PostgreSQL views and the two internal `clickhouse_mirror_*` control tables are intentionally excluded.

After the backfill, compact PostgreSQL triggers add only the changed table name, primary key, and operation to a coalescing outbox. The background mirror fetches the latest source row and batches it into ClickHouse. Repeated changes to one row occupy one outbox entry, so a ClickHouse outage does not duplicate full archive payloads in PostgreSQL.

Each ClickHouse table uses `ReplacingMergeTree(_mirror_version)` and adds:

- `_mirror_version`: monotonic PostgreSQL change version;
- `_mirror_deleted`: delete tombstone;
- `_mirror_synced_at`: time the version reached ClickHouse.

JSON/JSONB values are stored as JSON strings, PostgreSQL arrays become ClickHouse arrays, timestamps remain typed, and `bytea` archive payloads are base64 strings so every byte is recoverable.

## Configuration

The supplied Compose example starts ClickHouse 26.3 with persistent storage and binds its HTTP and native ports to localhost only. Copy `.env.production.example` to `.env.production`, replace both example database passwords, and keep the ClickHouse values aligned with `compose.example.yaml`.

```dotenv
CLICKHOUSE_URL=http://clickhouse:8123
CLICKHOUSE_DATABASE=twitch_logs
CLICKHOUSE_USERNAME=twitch_logs
CLICKHOUSE_PASSWORD=replace_this
CLICKHOUSE_MIRROR_BATCH_SIZE=1000
CLICKHOUSE_MIRROR_INTERVAL_MS=1000
```

Omit `CLICKHOUSE_URL` to disable the mirror. The batch size accepts `1` through `10000`; the polling interval accepts `100` through `60000` milliseconds.

Start the stack normally:

```powershell
docker compose -f compose.example.yaml up -d --build
```

The application does not depend on ClickHouse health during startup. If ClickHouse is unavailable, PostgreSQL writes and Twitch ingestion continue, the outbox retains the latest version of each changed row, and the mirror retries every five seconds. One application replica obtains a PostgreSQL advisory lock and performs mirroring; additional replicas remain idle for this work.

## Verify the mirror

List mirrored tables:

```powershell
docker compose -f compose.example.yaml exec clickhouse clickhouse-client `
  --user twitch_logs --password replace_this --database twitch_logs `
  --query "SHOW TABLES"
```

Check that every table finished its initial backfill and that no changes are waiting:

```sql
SELECT source_table, backfilled_at
FROM clickhouse_mirror_state
ORDER BY source_table;

SELECT count(*) AS pending_changes
FROM clickhouse_mirror_outbox;
```

Those queries run in PostgreSQL. A pending count of zero means ClickHouse has accepted every captured change. During an outage, a non-zero count is expected.

`ReplacingMergeTree` resolves versions during background merges. Use `FINAL` when correctness matters during an immediate comparison:

```sql
SELECT count()
FROM twitch_logs.chat_messages FINAL
WHERE NOT _mirror_deleted;

SELECT channel_id, count() AS messages
FROM twitch_logs.chat_messages FINAL
WHERE NOT _mirror_deleted
GROUP BY channel_id
ORDER BY messages DESC;
```

Compare compressed ClickHouse storage by table:

```sql
SELECT
  table,
  sum(rows) AS physical_rows,
  formatReadableSize(sum(data_compressed_bytes)) AS compressed,
  formatReadableSize(sum(data_uncompressed_bytes)) AS uncompressed
FROM system.parts
WHERE active AND database = 'twitch_logs'
GROUP BY table
ORDER BY sum(data_compressed_bytes) DESC;
```

## Boundaries before any cutover

- The mirror is eventually consistent and has no application read path.
- ClickHouse contains admin password hashes and all other PostgreSQL table data; protect its credentials and do not expose ports publicly.
- Delete tombstones and older row versions remain physically present until ClickHouse merges parts. Query current state with `FINAL` and `_mirror_deleted = false`.
- New tables and added columns are discovered within a minute and receive a fresh backfill. Removed ClickHouse columns are retained so source DDL cannot destroy mirrored data automatically; source type changes require an explicit ClickHouse migration.
- A successful build or an empty outbox is not proof that a future ClickHouse read implementation matches PostgreSQL behavior. Before replacement, benchmark representative dashboard queries and separately validate pagination, filters, moderation, constraints, transactional writes, archives, backup/restore, and outage recovery.
