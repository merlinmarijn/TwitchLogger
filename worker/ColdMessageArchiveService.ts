import { createHash, randomUUID } from "node:crypto";
import {
  brotliCompress,
  brotliDecompress,
  constants as zlibConstants,
} from "node:zlib";
import { promisify } from "node:util";
import {
  IMAGE_INDEX_VERSION,
  mergeIndexedImageUrls,
} from "../shared/imageUrls";
import { ARCHIVE_BROTLI_QUALITY } from "./ArchiveCompression";
import type { PostgresDatabase } from "./database";
import type { Logger } from "./logger";
import {
  collectOldestImageOwners,
  deduplicateImageUrls,
  type ImageOwner,
} from "./imageDeduplication";
import {
  resolveImageIndexes,
  type RemoteImageDetectorLike,
} from "./RemoteImageDetector";

const compress = promisify(brotliCompress);
const decompress = promisify(brotliDecompress);
const DAY_MS = 86_400_000;
const RETENTION_DAYS = 90;
const MAX_CHUNK_MESSAGES = 10_000;
const MAX_ARCHIVE_CHUNKS_PER_RUN = 10;
const MAX_COLD_SCAN = 1_000;
const ARCHIVE_INTERVAL_MS = 60 * 60 * 1_000;
const CODEC = "brotli-canonical-v1";

export interface ArchivedMessageRow {
  id: string;
  channel_id: string;
  platform: string;
  external_message_id: string;
  event_notification_id: string;
  external_channel_id: string;
  channel_name: string;
  sender_id: string;
  sender_username: string;
  sender_display_name: string;
  message_text: string;
  has_images: boolean;
  image_urls: string[] | null;
  image_index_version: number | null;
  gallery_channel_id: string | null;
  timestamp: number;
  badges: Array<{ setId: string; id: string; info: string }>;
  user_color: string | null;
  is_broadcaster: boolean;
  is_moderator: boolean;
  is_subscriber: boolean;
  is_vip: boolean;
  message_type: string;
  metadata: Record<string, unknown> | null;
  hidden_image_urls: string[];
  deleted_at: number | null;
  created_at: number;
}

interface ArchivedMessageDatabaseRow
  extends Omit<
    ArchivedMessageRow,
    | "image_index_version"
    | "timestamp"
    | "deleted_at"
    | "created_at"
  > {
  image_index_version: string | null;
  timestamp: string;
  deleted_at: string | null;
  created_at: string;
}

interface ColdChunkRow {
  id: string;
  message_count: string;
  uncompressed_bytes: string;
  compressed_bytes: string;
  sha256: string;
  payload: Buffer;
}

interface CatalogRow {
  id: string;
  chunk_id: string;
  timestamp: string;
}

export interface ColdArchiveCursor {
  timestamp: number;
  id: string;
}

export interface ColdArchivePage {
  rows: ArchivedMessageRow[];
  consumed?: ColdArchiveCursor;
  hasMore: boolean;
}

export interface ColdArchiveRunResult {
  enabled: boolean;
  chunksCreated: number;
  messagesArchived: number;
}

export interface ImageDeduplicationResult {
  changed: number;
  removed: number;
  scanned: number;
}

export class ColdMessageArchiveService {
  private timer?: ReturnType<typeof setInterval>;
  private activeRun?: Promise<ColdArchiveRunResult>;
  private stopped = false;
  private readonly decodedChunks = new Map<string, ArchivedMessageRow[]>();

  constructor(
    private readonly database: PostgresDatabase,
    private readonly logger?: Logger,
  ) {}

  start(onFatalError: (error: Error) => void) {
    this.timer = setInterval(() => {
      void this.runOnce().catch((cause) => {
        if (this.stopped) return;
        this.stop();
        const error = asError(cause);
        this.logger?.error(
          { err: error },
          "Cold-message archival failed; Twitch ingestion must remain paused",
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

  runOnce(): Promise<ColdArchiveRunResult> {
    if (this.activeRun) return this.activeRun;
    this.activeRun = this.performRun().finally(() => {
      this.activeRun = undefined;
    });
    return this.activeRun;
  }

  async hasMessagesBefore(cursor?: ColdArchiveCursor) {
    const values: unknown[] = [];
    let condition = "";
    if (cursor) {
      values.push(cursor.timestamp, cursor.id);
      condition = "AND (timestamp, id) < ($1, $2)";
    }
    const result = await this.database.query(`
      SELECT 1
      FROM chat_message_cold_catalog
      WHERE deleted_at IS NULL ${condition}
      LIMIT 1
    `, values);
    return Boolean(result.rowCount);
  }

  async pageRows(args: {
    channelId?: string;
    afterTimestamp?: number;
    cursor?: ColdArchiveCursor;
    imagesOnly: boolean;
    limit: number;
    matches: (row: ArchivedMessageRow) => boolean;
  }): Promise<ColdArchivePage> {
    const rows: ArchivedMessageRow[] = [];
    let cursor = args.cursor;
    let consumed: ColdArchiveCursor | undefined;
    let scanned = 0;
    let exhausted = false;

    while (rows.length < args.limit + 1 && scanned < MAX_COLD_SCAN && !exhausted) {
      const values: unknown[] = [];
      const conditions = ["deleted_at IS NULL"];
      if (args.channelId) {
        values.push(args.channelId);
        conditions.push(`channel_id = $${values.length}`);
      }
      if (args.afterTimestamp) {
        values.push(args.afterTimestamp);
        conditions.push(`timestamp > $${values.length}`);
      }
      if (args.imagesOnly) conditions.push("has_images = true");
      if (cursor) {
        values.push(cursor.timestamp, cursor.id);
        conditions.push(`(timestamp, id) < ($${values.length - 1}, $${values.length})`);
      }
      const batchSize = Math.min(250, MAX_COLD_SCAN - scanned);
      values.push(batchSize);
      const candidates = await this.database.query<CatalogRow>(`
        SELECT id, chunk_id, timestamp
        FROM chat_message_cold_catalog
        WHERE ${conditions.join(" AND ")}
        ORDER BY timestamp DESC, id DESC
        LIMIT $${values.length}
      `, values);
      if (candidates.rows.length === 0) {
        exhausted = true;
        break;
      }

      const chunks = await this.loadChunks(
        [...new Set(candidates.rows.map((candidate) => candidate.chunk_id))],
      );
      for (const candidate of candidates.rows) {
        const record = chunks.get(candidate.chunk_id)?.find(
          (message) => message.id === candidate.id,
        );
        if (!record) {
          throw new Error(`Cold archive catalog entry ${candidate.id} is missing from its chunk`);
        }
        if (record.timestamp !== Number(candidate.timestamp)) {
          throw new Error(`Cold archive catalog timestamp mismatch for ${candidate.id}`);
        }
        consumed = { timestamp: record.timestamp, id: record.id };
        cursor = consumed;
        scanned += 1;
        if (record.deleted_at === null && args.matches(record)) rows.push(record);
        if (rows.length >= args.limit + 1 || scanned >= MAX_COLD_SCAN) break;
      }
      exhausted = candidates.rows.length < batchSize;
    }

    return {
      rows: rows.slice(0, args.limit),
      consumed,
      hasMore: rows.length > args.limit || (!exhausted && scanned >= MAX_COLD_SCAN),
    };
  }

  async deleteMessages(messageIds: string[], deletedAt: number) {
    return this.mutateMessages(messageIds, (record) => {
      if (record.deleted_at !== null) return false;
      record.deleted_at = deletedAt;
      return true;
    });
  }

  async hideMessageImages(images: Array<{ messageId: string; url: string }>) {
    const urls = new Map(images.map((image) => [image.messageId, image.url]));
    return this.mutateMessages([...urls.keys()], (record) => {
      const url = urls.get(record.id);
      if (!url || record.deleted_at !== null || !record.image_urls?.includes(url)) return false;
      record.image_urls = record.image_urls.filter((candidate) => candidate !== url);
      if (!record.hidden_image_urls.includes(url)) record.hidden_image_urls.push(url);
      record.has_images = record.image_urls.length > 0;
      record.gallery_channel_id = record.has_images ? record.channel_id : null;
      return true;
    });
  }

  private async performRun(): Promise<ColdArchiveRunResult> {
    const enabled = await this.isEnabled();
    if (!enabled) return { enabled, chunksCreated: 0, messagesArchived: 0 };
    const cutoff = startOfUtcDay(Date.now() - RETENTION_DAYS * DAY_MS);
    let chunksCreated = 0;
    let messagesArchived = 0;
    for (let index = 0; index < MAX_ARCHIVE_CHUNKS_PER_RUN; index += 1) {
      const oldest = await this.oldestEligibleGroup(cutoff);
      if (!oldest) break;
      const archived = await this.archiveGroup(oldest.channelId, oldest.periodStart);
      chunksCreated += 1;
      messagesArchived += archived;
    }
    const result = { enabled, chunksCreated, messagesArchived };
    if (chunksCreated > 0) {
      this.logger?.info(result, "Canonical chat messages moved to cold archive");
    }
    return result;
  }

  async reindexImages(options: {
    isCancelled?: () => Promise<boolean>;
    onProgress?: (processed: number) => Promise<void>;
    remoteImageDetector?: RemoteImageDetectorLike;
  } = {}) {
    const chunks = await this.database.query<{ id: string }>(`
      SELECT id FROM chat_message_cold_chunks ORDER BY period_start, first_timestamp, id
    `);
    let processed = 0;
    let changed = 0;
    for (const chunk of chunks.rows) {
      if (await options.isCancelled?.()) break;
      const messages = await this.database.query<{ id: string }>(`
        SELECT id
        FROM chat_message_cold_catalog
        WHERE chunk_id = $1 AND deleted_at IS NULL
        ORDER BY id
      `, [chunk.id]);
      const messageIds = new Set(messages.rows.map((message) => message.id));
      const loaded = await this.loadChunks([chunk.id]);
      const records = (loaded.get(chunk.id) ?? [])
        .filter((record) => messageIds.has(record.id));
      const resolvedImageUrls = options.remoteImageDetector
        ? await resolveImageIndexes(
            options.remoteImageDetector,
            records.map((record) => ({
              messageText: record.message_text,
              indexedImageUrls: record.image_urls ?? [],
              hiddenImageUrls: record.hidden_image_urls,
            })),
            8,
            createProgressReporter(async (completed) => {
              await options.onProgress?.(processed + completed);
            }),
          )
        : records.map((record) => mergeIndexedImageUrls(
            record.message_text,
            record.image_urls ?? [],
            record.hidden_image_urls,
          ));
      const resolvedById = new Map(
        records.map((record, index) => [record.id, resolvedImageUrls[index]]),
      );
      changed += await this.mutateMessages(
        [...messageIds],
        (record) => {
          const imageUrls = mergeIndexedImageUrls(
            record.message_text,
            [...(record.image_urls ?? []), ...(resolvedById.get(record.id) ?? [])],
            record.hidden_image_urls,
          );
          const hasImages = imageUrls.length > 0;
          const galleryChannelId = hasImages ? record.channel_id : null;
          const isChanged =
            JSON.stringify(record.image_urls ?? []) !== JSON.stringify(imageUrls) ||
            record.has_images !== hasImages ||
            record.gallery_channel_id !== galleryChannelId ||
            record.image_index_version !== IMAGE_INDEX_VERSION;
          if (!isChanged) return false;
          record.image_urls = imageUrls;
          record.has_images = hasImages;
          record.gallery_channel_id = galleryChannelId;
          record.image_index_version = IMAGE_INDEX_VERSION;
          return true;
        },
      );
      processed += messages.rows.length;
      await options.onProgress?.(processed);
    }
    return { processed, changed };
  }

  async deduplicateImages(options: {
    isCancelled?: () => Promise<boolean>;
  } = {}): Promise<ImageDeduplicationResult> {
    const owners = new Map<string, ImageOwner>();
    const chunks = await this.database.query<{ id: string }>(`
      SELECT id FROM chat_message_cold_chunks ORDER BY period_start, first_timestamp, id
    `);
    let scanned = 0;
    for (const chunk of chunks.rows) {
      if (await options.isCancelled?.()) return { changed: 0, removed: 0, scanned };
      const active = await this.database.query<{ id: string }>(`
        SELECT id FROM chat_message_cold_catalog
        WHERE chunk_id = $1 AND deleted_at IS NULL
      `, [chunk.id]);
      const activeIds = new Set(active.rows.map((message) => message.id));
      const records = (await this.loadChunks([chunk.id])).get(chunk.id) ?? [];
      for (const record of records) {
        if (!activeIds.has(record.id)) continue;
        collectOldestImageOwners(owners, {
          id: record.id,
          imageUrls: record.image_urls ?? [],
          storageTier: "cold",
          timestamp: record.timestamp,
        });
        scanned += 1;
      }
    }

    let cursor = "";
    while (true) {
      if (await options.isCancelled?.()) return { changed: 0, removed: 0, scanned };
      const page = await this.database.query<{
        id: string;
        image_urls: string[];
        timestamp: string;
      }>(`
        SELECT id, image_urls, timestamp
        FROM chat_messages
        WHERE deleted_at IS NULL AND id > $1
        ORDER BY id LIMIT $2
      `, [cursor, MAX_CHUNK_MESSAGES]);
      if (page.rows.length === 0) break;
      for (const record of page.rows) {
        collectOldestImageOwners(owners, {
          id: record.id,
          imageUrls: record.image_urls ?? [],
          storageTier: "hot",
          timestamp: Number(record.timestamp),
        });
        scanned += 1;
      }
      cursor = page.rows.at(-1)!.id;
    }

    let changed = 0;
    let removed = 0;
    cursor = "";
    while (true) {
      if (await options.isCancelled?.()) return { changed, removed, scanned };
      const page = await this.database.query<{
        hidden_image_urls: string[];
        id: string;
        image_urls: string[];
        timestamp: string;
      }>(`
        SELECT id, image_urls, hidden_image_urls, timestamp
        FROM chat_messages
        WHERE deleted_at IS NULL AND id > $1
        ORDER BY id LIMIT $2
      `, [cursor, MAX_CHUNK_MESSAGES]);
      if (page.rows.length === 0) break;
      const client = await this.database.pool.connect();
      try {
        await client.query("BEGIN");
        for (const record of page.rows) {
          const deduplicated = deduplicateImageUrls(owners, {
            id: record.id,
            imageUrls: record.image_urls ?? [],
            storageTier: "hot",
            timestamp: Number(record.timestamp),
          });
          if (deduplicated.removedCount === 0) continue;
          const hiddenImageUrls = [...new Set([
            ...(record.hidden_image_urls ?? []),
            ...deduplicated.suppressedUrls,
          ])];
          await client.query(`
            UPDATE chat_messages
            SET image_urls = $2::jsonb, hidden_image_urls = $3::jsonb,
                has_images = $4,
                gallery_channel_id = CASE WHEN $4 THEN channel_id ELSE NULL END
            WHERE id = $1 AND deleted_at IS NULL
          `, [
            record.id,
            JSON.stringify(deduplicated.imageUrls),
            JSON.stringify(hiddenImageUrls),
            deduplicated.imageUrls.length > 0,
          ]);
          changed += 1;
          removed += deduplicated.removedCount;
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      cursor = page.rows.at(-1)!.id;
    }

    for (const chunk of chunks.rows) {
      if (await options.isCancelled?.()) return { changed, removed, scanned };
      const active = await this.database.query<{ id: string }>(`
        SELECT id FROM chat_message_cold_catalog
        WHERE chunk_id = $1 AND deleted_at IS NULL
      `, [chunk.id]);
      const removedByMessage = new Map<string, number>();
      const chunkChanged = await this.mutateMessages(
        active.rows.map((message) => message.id),
        (record) => {
          const deduplicated = deduplicateImageUrls(owners, {
            id: record.id,
            imageUrls: record.image_urls ?? [],
            storageTier: "cold",
            timestamp: record.timestamp,
          });
          if (deduplicated.removedCount === 0) return false;
          record.image_urls = deduplicated.imageUrls;
          record.hidden_image_urls = [...new Set([
            ...record.hidden_image_urls,
            ...deduplicated.suppressedUrls,
          ])];
          record.has_images = record.image_urls.length > 0;
          record.gallery_channel_id = record.has_images ? record.channel_id : null;
          removedByMessage.set(record.id, deduplicated.removedCount);
          return true;
        },
      );
      changed += chunkChanged;
      removed += [...removedByMessage.values()].reduce((sum, count) => sum + count, 0);
    }
    return { changed, removed, scanned };
  }

  async inspectIntegrity(issueLimit = 100) {
    if (issueLimit <= 0) return { checked: 0, issues: [] };
    const chunks = await this.database.query<ColdChunkRow>(`
      SELECT id, message_count, uncompressed_bytes, compressed_bytes, sha256, payload
      FROM chat_message_cold_chunks
      ORDER BY period_start, first_timestamp, id
    `);
    const issues: Array<{ id: string; issue: string }> = [];
    let checked = 0;
    for (const chunk of chunks.rows) {
      let records: ArchivedMessageRow[];
      try {
        records = await verifyStoredChunk(chunk);
      } catch (error) {
        issues.push({
          id: chunk.id,
          issue: `Archive verification failed: ${asError(error).message}`,
        });
        continue;
      }
      const catalog = await this.database.query<{
        id: string;
        channel_id: string;
        timestamp: string;
        has_images: boolean;
        deleted_at: string | null;
      }>(`
        SELECT id, channel_id, timestamp, has_images, deleted_at
        FROM chat_message_cold_catalog
        WHERE chunk_id = $1
      `, [chunk.id]);
      const catalogById = new Map(catalog.rows.map((row) => [row.id, row]));
      for (const record of records) {
        checked += 1;
        const entry = catalogById.get(record.id);
        const expectedImages = mergeIndexedImageUrls(
          record.message_text,
          record.image_urls ?? [],
          record.hidden_image_urls,
        );
        const catalogDeletedAt = entry?.deleted_at === null
          ? null
          : Number(entry?.deleted_at);
        if (
          !entry ||
          entry.channel_id !== record.channel_id ||
          Number(entry.timestamp) !== record.timestamp ||
          entry.has_images !== record.has_images ||
          catalogDeletedAt !== record.deleted_at
        ) {
          issues.push({ id: record.id, issue: "Cold catalog does not match its archive record" });
        } else if (
          JSON.stringify(record.image_urls ?? []) !== JSON.stringify(expectedImages) ||
          record.has_images !== (expectedImages.length > 0)
        ) {
          issues.push({ id: record.id, issue: "Cold image metadata does not match indexed URLs" });
        }
        if (issues.length >= issueLimit) return { checked, issues };
      }
      if (catalog.rows.length !== records.length && issues.length < issueLimit) {
        issues.push({ id: chunk.id, issue: "Cold archive and catalog counts differ" });
      }
    }
    return { checked, issues };
  }

  private async isEnabled() {
    const result = await this.database.query<{ enabled: boolean }>(`
      SELECT enabled FROM archive_settings WHERE key = 'cold_message_archive'
    `);
    return result.rows[0]?.enabled === true;
  }

  private async oldestEligibleGroup(cutoff: number) {
    const result = await this.database.query<{
      channel_id: string;
      period_start: string;
      raw_message_data: unknown;
    }>(`
      SELECT channel_id, (timestamp / $2::bigint) * $2::bigint AS period_start,
             raw_message_data
      FROM chat_messages
      WHERE timestamp < $1
      ORDER BY timestamp, channel_id
      LIMIT 1
    `, [cutoff, DAY_MS]);
    const row = result.rows[0];
    if (!row) return undefined;
    if (row.raw_message_data !== null) {
      throw new Error(
        "An eligible canonical message still contains unarchived raw data; cold archival paused",
      );
    }
    return { channelId: row.channel_id, periodStart: Number(row.period_start) };
  }

  private async archiveGroup(channelId: string, periodStart: number) {
    const periodEnd = periodStart + DAY_MS;
    const source = await this.database.query<ArchivedMessageDatabaseRow>(`
      SELECT
        id, channel_id, platform, external_message_id,
        event_notification_id, external_channel_id, channel_name, sender_id,
        sender_username, sender_display_name, message_text, has_images, image_urls,
        image_index_version, gallery_channel_id, timestamp, badges, user_color,
        is_broadcaster, is_moderator, is_subscriber, is_vip, message_type,
        metadata, hidden_image_urls, deleted_at, created_at
      FROM chat_messages
      WHERE channel_id = $1 AND timestamp >= $2 AND timestamp < $3
        AND raw_message_data IS NULL
      ORDER BY timestamp, id
      LIMIT $4
    `, [channelId, periodStart, periodEnd, MAX_CHUNK_MESSAGES]);
    if (source.rows.length === 0) {
      throw new Error("Cold archive group disappeared before it could be read");
    }
    const records = source.rows.map(toArchivedMessage);
    const encoded = await encodeColdMessageChunk(records);
    await verifyColdMessageChunk(encoded.payload, {
      sha256: encoded.sha256,
      messageCount: records.length,
      uncompressedBytes: encoded.uncompressedBytes,
    });

    const client = await this.database.pool.connect();
    try {
      await client.query("BEGIN");
      const chunkId = randomUUID();
      await client.query(`
        INSERT INTO chat_message_cold_chunks (
          id, channel_id, period_start, period_end, first_timestamp,
          last_timestamp, message_count, codec, uncompressed_bytes,
          compressed_bytes, sha256, payload, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      `, [
        chunkId,
        channelId,
        periodStart,
        periodEnd,
        records[0].timestamp,
        records.at(-1)!.timestamp,
        records.length,
        CODEC,
        encoded.uncompressedBytes,
        encoded.compressedBytes,
        encoded.sha256,
        encoded.payload,
        Date.now(),
      ]);
      await client.query(`
        INSERT INTO chat_message_cold_catalog (
          id, external_message_id, chunk_id, channel_id,
          timestamp, has_images, deleted_at, sender_username, sender_display_name
        )
        SELECT *
        FROM unnest(
          $1::text[], $2::text[], $3::text[], $4::text[],
          $5::bigint[], $6::boolean[], $7::bigint[], $8::text[], $9::text[]
        )
      `, [
        records.map((record) => record.id),
        records.map((record) => record.external_message_id),
        records.map(() => chunkId),
        records.map((record) => record.channel_id),
        records.map((record) => record.timestamp),
        records.map((record) => record.has_images),
        records.map((record) => record.deleted_at),
        records.map((record) => record.sender_username),
        records.map((record) => record.sender_display_name),
      ]);
      const deleted = await client.query(`
        DELETE FROM chat_messages WHERE id = ANY($1::text[])
      `, [records.map((record) => record.id)]);
      if (deleted.rowCount !== records.length) {
        throw new Error(
          `Canonical source changed during archival: expected ${records.length}, removed ${deleted.rowCount ?? 0}`,
        );
      }
      await client.query("COMMIT");
      this.decodedChunks.set(chunkId, records);
      return records.length;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async loadChunks(chunkIds: string[]) {
    const loaded = new Map<string, ArchivedMessageRow[]>();
    const missing = chunkIds.filter((id) => {
      const cached = this.decodedChunks.get(id);
      if (cached) loaded.set(id, cached);
      return !cached;
    });
    if (missing.length > 0) {
      const result = await this.database.query<ColdChunkRow>(`
        SELECT id, message_count, uncompressed_bytes, compressed_bytes, sha256, payload
        FROM chat_message_cold_chunks
        WHERE id = ANY($1::text[])
      `, [missing]);
      if (result.rows.length !== missing.length) {
        throw new Error("One or more cold archive chunks are missing");
      }
      for (const chunk of result.rows) {
        const records = await verifyStoredChunk(chunk);
        this.cacheChunk(chunk.id, records);
        loaded.set(chunk.id, records);
      }
    }
    return loaded;
  }

  private async mutateMessages(
    messageIds: string[],
    mutate: (record: ArchivedMessageRow) => boolean,
  ) {
    if (messageIds.length === 0) return 0;
    const catalog = await this.database.query<{ id: string; chunk_id: string }>(`
      SELECT id, chunk_id
      FROM chat_message_cold_catalog
      WHERE id = ANY($1::text[])
    `, [messageIds]);
    const idsByChunk = new Map<string, Set<string>>();
    for (const row of catalog.rows) {
      const ids = idsByChunk.get(row.chunk_id) ?? new Set<string>();
      ids.add(row.id);
      idsByChunk.set(row.chunk_id, ids);
    }

    let changed = 0;
    for (const [chunkId, ids] of idsByChunk) {
      const client = await this.database.pool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query<ColdChunkRow>(`
          SELECT id, message_count, uncompressed_bytes, compressed_bytes, sha256, payload
          FROM chat_message_cold_chunks
          WHERE id = $1
          FOR UPDATE
        `, [chunkId]);
        const chunk = result.rows[0];
        if (!chunk) throw new Error(`Cold archive chunk ${chunkId} is missing`);
        const records = await verifyStoredChunk(chunk);
        let chunkChanged = 0;
        for (const record of records) {
          if (ids.has(record.id) && mutate(record)) chunkChanged += 1;
        }
        if (chunkChanged > 0) {
          const encoded = await encodeColdMessageChunk(records);
          await verifyColdMessageChunk(encoded.payload, {
            sha256: encoded.sha256,
            messageCount: records.length,
            uncompressedBytes: encoded.uncompressedBytes,
          });
          await client.query(`
            UPDATE chat_message_cold_chunks
            SET uncompressed_bytes=$2, compressed_bytes=$3, sha256=$4, payload=$5
            WHERE id=$1
          `, [
            chunkId,
            encoded.uncompressedBytes,
            encoded.compressedBytes,
            encoded.sha256,
            encoded.payload,
          ]);
          for (const record of records.filter((candidate) => ids.has(candidate.id))) {
            await client.query(`
              UPDATE chat_message_cold_catalog
              SET deleted_at=$2, has_images=$3
              WHERE id=$1
            `, [record.id, record.deleted_at, record.has_images]);
          }
          changed += chunkChanged;
          this.cacheChunk(chunkId, records);
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }
    return changed;
  }

  private cacheChunk(chunkId: string, records: ArchivedMessageRow[]) {
    this.decodedChunks.delete(chunkId);
    this.decodedChunks.set(chunkId, records);
    while (this.decodedChunks.size > 32) {
      this.decodedChunks.delete(this.decodedChunks.keys().next().value!);
    }
  }
}

function createProgressReporter(
  report: (completed: number) => Promise<void>,
  intervalMs = 1_000,
) {
  let lastReportedAt = 0;
  return async (completed: number) => {
    const now = Date.now();
    if (now - lastReportedAt < intervalMs) return;
    lastReportedAt = now;
    await report(completed);
  };
}

export async function encodeColdMessageChunk(records: ArchivedMessageRow[]) {
  if (records.length === 0) throw new Error("Cannot encode an empty cold-message chunk");
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

export async function verifyColdMessageChunk(
  payload: Buffer,
  expected: { sha256: string; messageCount: number; uncompressedBytes: number },
) {
  const uncompressed = await decompress(payload);
  if (uncompressed.length !== expected.uncompressedBytes) {
    throw new Error("Cold-message archive byte count does not match its manifest");
  }
  const sha256 = createHash("sha256").update(uncompressed).digest("hex");
  if (sha256 !== expected.sha256) {
    throw new Error("Cold-message archive checksum does not match its manifest");
  }
  const text = uncompressed.toString("utf8");
  const records = text.length === 0
    ? []
    : text.split("\n").map((line) => JSON.parse(line) as ArchivedMessageRow);
  if (records.length !== expected.messageCount) {
    throw new Error("Cold-message archive record count does not match its manifest");
  }
  return records;
}

async function verifyStoredChunk(chunk: ColdChunkRow) {
  if (chunk.payload.length !== Number(chunk.compressed_bytes)) {
    throw new Error("Stored cold-message archive size does not match its manifest");
  }
  return verifyColdMessageChunk(chunk.payload, {
    sha256: chunk.sha256,
    messageCount: Number(chunk.message_count),
    uncompressedBytes: Number(chunk.uncompressed_bytes),
  });
}

function toArchivedMessage(row: ArchivedMessageDatabaseRow): ArchivedMessageRow {
  return {
    ...row,
    image_index_version:
      row.image_index_version === null ? null : Number(row.image_index_version),
    timestamp: Number(row.timestamp),
    deleted_at: row.deleted_at === null ? null : Number(row.deleted_at),
    created_at: Number(row.created_at),
  };
}

function startOfUtcDay(timestamp: number) {
  return Math.floor(timestamp / DAY_MS) * DAY_MS;
}

function asError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}
