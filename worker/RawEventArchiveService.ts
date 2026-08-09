import { createHash, randomUUID } from "node:crypto";
import {
  brotliCompress,
  brotliDecompress,
  constants as zlibConstants,
} from "node:zlib";
import { promisify } from "node:util";
import type { PoolClient } from "pg";
import { ARCHIVE_BROTLI_QUALITY } from "./ArchiveCompression";
import type { PostgresDatabase } from "./database";
import type { Logger } from "./logger";

const compress = promisify(brotliCompress);
const decompress = promisify(brotliDecompress);
const DAY_MS = 86_400_000;
const MAX_CHUNK_MESSAGES = 10_000;
const MAX_STARTUP_CHUNKS = 100;
const ARCHIVE_INTERVAL_MS = 10 * 60 * 1_000;
const CODEC = "brotli-v1";

export interface RawEventArchiveRecord {
  externalMessageId: string;
  eventNotificationId: string;
  channelId: string;
  timestamp: number;
  rawMessageData: unknown;
}

interface RawEventRow {
  external_message_id: string;
  event_notification_id: string;
  channel_id: string;
  timestamp: string;
  raw_message_data: unknown;
}

interface ArchiveChunkRow {
  id: string;
  message_count: string;
  uncompressed_bytes: string;
  compressed_bytes: string;
  sha256: string;
  payload: Buffer;
}

export interface RawArchiveRunResult {
  chunksCreated: number;
  messagesArchived: number;
  sourcesStaged: number;
  sourcesCleared: number;
  cleanupEnabled: boolean;
}

export class RawEventArchiveService {
  private timer?: ReturnType<typeof setInterval>;
  private activeRun?: Promise<RawArchiveRunResult>;
  private stopped = false;

  constructor(
    private readonly database: PostgresDatabase,
    private readonly logger: Logger,
  ) {}

  start(onFatalError: (error: Error) => void) {
    this.timer = setInterval(() => {
      void this.runOnce().catch((cause) => {
        if (this.stopped) return;
        this.stop();
        const error = asError(cause);
        this.logger.error(
          { err: error },
          "Raw-event archival failed; Twitch ingestion must remain paused",
        );
        onFatalError(error);
      });
    }, ARCHIVE_INTERVAL_MS);
    this.timer.unref();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  runOnce(): Promise<RawArchiveRunResult> {
    if (this.activeRun) return this.activeRun;
    this.activeRun = this.performRun().finally(() => {
      this.activeRun = undefined;
    });
    return this.activeRun;
  }

  private async performRun(): Promise<RawArchiveRunResult> {
    const cleanupEnabled = await this.isSourceCleanupEnabled();
    let chunksCreated = 0;
    let messagesArchived = 0;
    let sourcesCleared = cleanupEnabled
      ? await this.clearPreviouslyVerifiedSources()
      : 0;
    const sourcesStaged = cleanupEnabled
      ? await this.stageUnarchivedSources()
      : 0;
    const cutoff = startOfUtcDay(Date.now());

    for (let index = 0; index < MAX_STARTUP_CHUNKS; index += 1) {
      const group = await this.oldestSealedGroup(cutoff);
      if (!group) break;
      const archived = await this.archiveGroup(
        group.channelId,
        group.periodStart,
        cleanupEnabled,
      );
      chunksCreated += 1;
      messagesArchived += archived.messagesArchived;
      sourcesCleared += archived.sourcesCleared;
    }

    const result = {
      chunksCreated,
      messagesArchived,
      sourcesStaged,
      sourcesCleared,
      cleanupEnabled,
    };
    if (chunksCreated > 0 || sourcesStaged > 0 || sourcesCleared > 0) {
      this.logger.info(result, "Raw Twitch events archived and verified");
    }
    return result;
  }

  private async isSourceCleanupEnabled() {
    const result = await this.database.query<{ enabled: boolean }>(`
      SELECT enabled FROM archive_settings WHERE key = 'raw_source_cleanup'
    `);
    return result.rows[0]?.enabled === true;
  }

  private async stageUnarchivedSources() {
    const result = await this.database.query(`
      INSERT INTO chat_raw_events (
        external_message_id, event_notification_id, channel_id,
        timestamp, raw_message_data, created_at
      )
      SELECT
        message.external_message_id,
        message.event_notification_id,
        message.channel_id,
        message.timestamp,
        message.raw_message_data,
        message.created_at
      FROM chat_messages AS message
      LEFT JOIN chat_raw_events AS staged
        ON staged.external_message_id = message.external_message_id
      WHERE message.raw_message_data IS NOT NULL
        AND staged.external_message_id IS NULL
      ON CONFLICT (external_message_id) DO NOTHING
    `);
    return result.rowCount ?? 0;
  }

  private async oldestSealedGroup(cutoff: number) {
    const result = await this.database.query<{
      channel_id: string;
      period_start: string;
    }>(`
      SELECT channel_id, (timestamp / $2::bigint) * $2::bigint AS period_start
      FROM chat_raw_events
      WHERE timestamp < $1
      ORDER BY timestamp, channel_id
      LIMIT 1
    `, [cutoff, DAY_MS]);
    const row = result.rows[0];
    return row
      ? { channelId: row.channel_id, periodStart: Number(row.period_start) }
      : undefined;
  }

  private async archiveGroup(
    channelId: string,
    periodStart: number,
    cleanupEnabled: boolean,
  ) {
    const periodEnd = periodStart + DAY_MS;
    const result = await this.database.query<RawEventRow>(`
      SELECT external_message_id, event_notification_id, channel_id,
             timestamp, raw_message_data
      FROM chat_raw_events
      WHERE channel_id = $1 AND timestamp >= $2 AND timestamp < $3
      ORDER BY timestamp, external_message_id
      LIMIT $4
    `, [channelId, periodStart, periodEnd, MAX_CHUNK_MESSAGES]);
    if (result.rows.length === 0) {
      throw new Error("Raw-event archive group disappeared before it could be read");
    }

    const records = result.rows.map(toArchiveRecord);
    const encoded = await encodeRawArchiveChunk(records);
    await verifyRawArchiveChunk(encoded.payload, {
      sha256: encoded.sha256,
      messageCount: records.length,
      uncompressedBytes: encoded.uncompressedBytes,
    });

    const client = await this.database.pool.connect();
    try {
      await client.query("BEGIN");
      const chunkId = await this.storeOrVerifyChunk(client, {
        id: randomUUID(),
        channelId,
        periodStart,
        periodEnd,
        firstTimestamp: records[0].timestamp,
        lastTimestamp: records.at(-1)!.timestamp,
        records,
        ...encoded,
      });
      const messageIds = records.map((record) => record.externalMessageId);
      const deleted = await client.query(`
        DELETE FROM chat_raw_events
        WHERE external_message_id = ANY($1::text[])
      `, [messageIds]);
      if (deleted.rowCount !== records.length) {
        throw new Error(
          `Raw-event staging changed during archival: expected ${records.length}, removed ${deleted.rowCount ?? 0}`,
        );
      }

      let sourcesCleared = 0;
      if (cleanupEnabled) {
        const cleared = await client.query(`
          UPDATE chat_messages
          SET raw_message_data = NULL
          WHERE external_message_id = ANY($1::text[])
            AND raw_message_data IS NOT NULL
        `, [messageIds]);
        sourcesCleared = cleared.rowCount ?? 0;
        await client.query(`
          UPDATE chat_raw_event_chunks SET source_cleared_at = $2 WHERE id = $1
        `, [chunkId, Date.now()]);
      }
      await client.query("COMMIT");
      return { messagesArchived: records.length, sourcesCleared };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async storeOrVerifyChunk(
    client: PoolClient,
    chunk: {
      id: string;
      channelId: string;
      periodStart: number;
      periodEnd: number;
      firstTimestamp: number;
      lastTimestamp: number;
      records: RawEventArchiveRecord[];
      payload: Buffer;
      sha256: string;
      uncompressedBytes: number;
      compressedBytes: number;
    },
  ) {
    const existing = await client.query<ArchiveChunkRow>(`
      SELECT id, message_count, uncompressed_bytes, compressed_bytes, sha256, payload
      FROM chat_raw_event_chunks
      WHERE sha256 = $1
      FOR UPDATE
    `, [chunk.sha256]);
    const row = existing.rows[0];
    if (row) {
      await verifyStoredChunk(row);
      if (
        Number(row.message_count) !== chunk.records.length ||
        Number(row.uncompressed_bytes) !== chunk.uncompressedBytes ||
        Number(row.compressed_bytes) !== chunk.compressedBytes ||
        !row.payload.equals(chunk.payload)
      ) {
        throw new Error("An existing raw-event archive chunk failed byte-for-byte verification");
      }
      return row.id;
    }

    await client.query(`
      INSERT INTO chat_raw_event_chunks (
        id, channel_id, period_start, period_end, first_timestamp, last_timestamp,
        message_count, codec, uncompressed_bytes, compressed_bytes, sha256,
        payload, created_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
      )
    `, [
      chunk.id,
      chunk.channelId,
      chunk.periodStart,
      chunk.periodEnd,
      chunk.firstTimestamp,
      chunk.lastTimestamp,
      chunk.records.length,
      CODEC,
      chunk.uncompressedBytes,
      chunk.compressedBytes,
      chunk.sha256,
      chunk.payload,
      Date.now(),
    ]);
    return chunk.id;
  }

  private async clearPreviouslyVerifiedSources() {
    let cleared = 0;
    for (let index = 0; index < MAX_STARTUP_CHUNKS; index += 1) {
      const result = await this.database.query<ArchiveChunkRow>(`
        SELECT id, message_count, uncompressed_bytes, compressed_bytes, sha256, payload
        FROM chat_raw_event_chunks
        WHERE source_cleared_at IS NULL
        ORDER BY period_start, first_timestamp
        LIMIT 1
      `);
      const chunk = result.rows[0];
      if (!chunk) break;
      const records = await verifyStoredChunk(chunk);
      const client = await this.database.pool.connect();
      try {
        await client.query("BEGIN");
        const updated = await client.query(`
          UPDATE chat_messages
          SET raw_message_data = NULL
          WHERE external_message_id = ANY($1::text[])
            AND raw_message_data IS NOT NULL
        `, [records.map((record) => record.externalMessageId)]);
        await client.query(`
          UPDATE chat_raw_event_chunks
          SET source_cleared_at = $2
          WHERE id = $1 AND source_cleared_at IS NULL
        `, [chunk.id, Date.now()]);
        await client.query("COMMIT");
        cleared += updated.rowCount ?? 0;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }
    return cleared;
  }
}

export async function encodeRawArchiveChunk(records: RawEventArchiveRecord[]) {
  if (records.length === 0) throw new Error("Cannot encode an empty raw-event archive chunk");
  const uncompressed = Buffer.from(
    records.map((record) => JSON.stringify(record)).join("\n"),
    "utf8",
  );
  const payload = await compress(uncompressed, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: ARCHIVE_BROTLI_QUALITY,
      [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
    },
  });
  return {
    payload,
    sha256: createHash("sha256").update(uncompressed).digest("hex"),
    uncompressedBytes: uncompressed.length,
    compressedBytes: payload.length,
  };
}

export async function verifyRawArchiveChunk(
  payload: Buffer,
  expected: {
    sha256: string;
    messageCount: number;
    uncompressedBytes: number;
  },
) {
  const uncompressed = await decompress(payload);
  if (uncompressed.length !== expected.uncompressedBytes) {
    throw new Error("Raw-event archive byte count does not match its manifest");
  }
  const sha256 = createHash("sha256").update(uncompressed).digest("hex");
  if (sha256 !== expected.sha256) {
    throw new Error("Raw-event archive checksum does not match its manifest");
  }
  const text = uncompressed.toString("utf8");
  const records = text.length === 0
    ? []
    : text.split("\n").map((line) => JSON.parse(line) as RawEventArchiveRecord);
  if (records.length !== expected.messageCount) {
    throw new Error("Raw-event archive record count does not match its manifest");
  }
  return records;
}

async function verifyStoredChunk(chunk: ArchiveChunkRow) {
  if (chunk.payload.length !== Number(chunk.compressed_bytes)) {
    throw new Error("Stored raw-event archive compressed size does not match its manifest");
  }
  return verifyRawArchiveChunk(chunk.payload, {
    sha256: chunk.sha256,
    messageCount: Number(chunk.message_count),
    uncompressedBytes: Number(chunk.uncompressed_bytes),
  });
}

function toArchiveRecord(row: RawEventRow): RawEventArchiveRecord {
  return {
    externalMessageId: row.external_message_id,
    eventNotificationId: row.event_notification_id,
    channelId: row.channel_id,
    timestamp: Number(row.timestamp),
    rawMessageData: row.raw_message_data,
  };
}

function startOfUtcDay(timestamp: number) {
  return Math.floor(timestamp / DAY_MS) * DAY_MS;
}

function asError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}
