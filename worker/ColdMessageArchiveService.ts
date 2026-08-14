import { createHash, randomUUID } from "node:crypto";
import {
  brotliCompress,
  brotliDecompress,
  constants as zlibConstants,
} from "node:zlib";
import { promisify } from "node:util";
import type { PoolClient } from "pg";
import type { NativeEmote } from "../shared/nativeEmotes";
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
const MAX_CHUNK_MESSAGES = 2_000;
const MAX_ARCHIVE_CHUNKS_PER_RUN = 10;
const MAX_LEGACY_MIGRATIONS_PER_RUN = 10;
const MAX_COLD_SCAN = 1_000;
const ARCHIVE_INTERVAL_MS = 60 * 60 * 1_000;
const CODEC = "brotli-positional-v3";
const DEFAULT_CACHE_CHUNKS = 32;
const DEFAULT_CACHE_BYTES = 64 * 1024 * 1024;

export interface ArchivedMessageRow {
  id: string;
  channel_id: string;
  platform: string;
  external_message_id: string;
  event_notification_id?: string;
  external_channel_id: string;
  channel_name: string;
  sender_id: string;
  sender_username: string;
  sender_display_name: string;
  message_text: string;
  has_images: boolean;
  image_urls: string[] | null;
  image_index_version: number | null;
  gallery_channel_id?: string | null;
  timestamp: number;
  badges: Array<{ setId: string; id: string; info: string }>;
  user_color: string | null;
  is_broadcaster: boolean;
  is_moderator: boolean;
  is_subscriber: boolean;
  is_vip: boolean;
  message_type: string;
  native_emotes?: NativeEmote[] | null;
  metadata?: Record<string, unknown> | null;
  hidden_image_urls: string[];
  deleted_at: number | null;
  created_at?: number;
  sender_profile_id?: string | number;
}

interface ArchivedMessageDatabaseRow
  extends Omit<
    ArchivedMessageRow,
    | "image_index_version"
    | "timestamp"
    | "deleted_at"
    | "hidden_image_urls"
  > {
  image_index_version: string | null;
  timestamp: string;
  deleted_at: string | null;
  hidden_image_urls: string[] | null;
}

interface ColdChunkRow {
  id: string;
  message_count: string;
  uncompressed_bytes: string;
  compressed_bytes: string;
  sha256: string;
  payload: Buffer;
  compact_indexed?: boolean;
  active_message_count?: string | null;
  image_message_count?: string | null;
  codec?: string;
}

interface CatalogRow {
  id: string;
  chunk_id: string;
  timestamp: string;
}

interface CompactChunkMeta {
  id: string;
  first_timestamp: string;
  last_timestamp: string;
}

interface ColdCandidatePage {
  rows: ArchivedMessageRow[];
  hasMore: boolean;
}

interface ColdImageRow {
  record: ArchivedMessageRow;
}

interface ColdSenderStat {
  senderProfileId: number | null;
  senderUsername: string | null;
  senderDisplayName: string | null;
  messageCount: number;
  lastTimestamp: number;
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
  chunksMigrated: number;
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
  private readonly decodedChunkBytes = new Map<string, number>();
  private cachedBytes = 0;
  private readonly cacheMetrics = { hits: 0, misses: 0, evictions: 0 };
  private readonly maxCacheChunks = positiveInteger(
    process.env.COLD_ARCHIVE_CACHE_MAX_CHUNKS,
    DEFAULT_CACHE_CHUNKS,
  );
  private readonly maxCacheBytes = positiveInteger(
    process.env.COLD_ARCHIVE_CACHE_MAX_BYTES,
    DEFAULT_CACHE_BYTES,
  );

  constructor(
    private readonly database: PostgresDatabase,
    private readonly logger?: Logger,
  ) {}

  getCacheMetrics() {
    return {
      ...this.cacheMetrics,
      chunks: this.decodedChunks.size,
      bytes: this.cachedBytes,
    };
  }

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
    const page = await this.pageRows({
      ...(cursor ? { cursor } : {}),
      imagesOnly: false,
      limit: 1,
      matches: () => true,
    });
    return page.rows.length > 0;
  }

  async pageRows(args: {
    channelId?: string;
    afterTimestamp?: number;
    cursor?: ColdArchiveCursor;
    imagesOnly: boolean;
    limit: number;
    matches: (row: ArchivedMessageRow) => boolean;
  }): Promise<ColdArchivePage> {
    const candidateLimit = MAX_COLD_SCAN + 1;
    const [legacy, compact, images] = await Promise.all([
      this.legacyCandidates(args, candidateLimit),
      this.compactCandidates(args, candidateLimit),
      args.imagesOnly
        ? this.imageCandidates(args, candidateLimit)
        : Promise.resolve({ rows: [], hasMore: false }),
    ]);
    const candidates = mergeCandidateRows(
      mergeCandidateRows(legacy.rows, compact.rows, candidateLimit),
      images.rows,
      candidateLimit,
    );
    const rows: ArchivedMessageRow[] = [];
    let consumed: ColdArchiveCursor | undefined;
    let scanned = 0;
    for (const candidate of candidates) {
      if (scanned >= MAX_COLD_SCAN || rows.length >= args.limit + 1) break;
      consumed = { timestamp: candidate.timestamp, id: candidate.id };
      scanned += 1;
      if (args.matches(candidate)) rows.push(candidate);
    }

    return {
      rows: rows.slice(0, args.limit),
      consumed,
      hasMore:
        rows.length > args.limit ||
        candidates.length > scanned ||
        legacy.hasMore ||
        compact.hasMore ||
        images.hasMore,
    };
  }

  async countReencodeCandidates() {
    const result = await this.database.query<{ count: string }>(`
      SELECT count(*) AS count FROM chat_message_cold_chunks
      WHERE compact_indexed = false OR codec <> $1 OR image_projection_indexed = false
    `, [CODEC]);
    return Number(result.rows[0]?.count ?? 0);
  }

  async reencodeChunks(options: {
    isCancelled?: () => Promise<boolean>;
    onProgress?: (processed: number) => Promise<void>;
  } = {}) {
    let processed = 0;
    while (!await options.isCancelled?.()) {
      const migrated = await this.migrateLegacyChunks(1);
      if (migrated === 0) break;
      processed += migrated;
      await options.onProgress?.(processed);
    }
    return processed;
  }

  private async imageCandidates(
    args: { channelId?: string; afterTimestamp?: number; cursor?: ColdArchiveCursor },
    limit: number,
  ): Promise<ColdCandidatePage> {
    const values: unknown[] = [];
    const conditions: string[] = [];
    if (args.channelId) {
      values.push(args.channelId);
      conditions.push(`image.channel_key = (SELECT storage_key FROM channels WHERE id = $${values.length})`);
    }
    if (args.afterTimestamp) {
      values.push(args.afterTimestamp);
      conditions.push(`image.timestamp > $${values.length}`);
    }
    if (args.cursor) {
      values.push(args.cursor.timestamp, args.cursor.id);
      conditions.push(`(image.timestamp, image.id) < ($${values.length - 1}, $${values.length})`);
    }
    values.push(limit);
    const result = await this.database.query<ColdImageRow>(`
      SELECT image.record
      FROM chat_message_cold_images AS image
      ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY image.timestamp DESC, image.id DESC
      LIMIT $${values.length}
    `, values);
    return {
      rows: result.rows.slice(0, limit - 1).map((row) => row.record),
      hasMore: result.rows.length === limit,
    };
  }

  private async legacyCandidates(
    args: {
      channelId?: string;
      afterTimestamp?: number;
      cursor?: ColdArchiveCursor;
      imagesOnly: boolean;
    },
    limit: number,
  ): Promise<ColdCandidatePage> {
    const values: unknown[] = [];
    const conditions = ["catalog.deleted_at IS NULL", "chunk.compact_indexed = false"];
    if (args.channelId) {
      values.push(args.channelId);
      conditions.push(`catalog.channel_key = (SELECT storage_key FROM channels WHERE id = $${values.length})`);
    }
    if (args.afterTimestamp) {
      values.push(args.afterTimestamp);
      conditions.push(`catalog.timestamp > $${values.length}`);
    }
    if (args.imagesOnly) conditions.push("catalog.has_images = true");
    if (args.cursor) {
      values.push(args.cursor.timestamp, args.cursor.id);
      conditions.push(`(catalog.timestamp, catalog.id) < ` +
        `($${values.length - 1}, $${values.length})`);
    }
    values.push(limit);
    const candidates = await this.database.query<CatalogRow>(`
      SELECT catalog.id, catalog.chunk_id, catalog.timestamp
      FROM chat_message_cold_catalog AS catalog
      JOIN chat_message_cold_chunks AS chunk ON chunk.id = catalog.chunk_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY catalog.timestamp DESC, catalog.id DESC
      LIMIT $${values.length}
    `, values);
    const visible = candidates.rows.slice(0, limit - 1);
    const chunks = await this.loadChunks(
      [...new Set(visible.map((candidate) => candidate.chunk_id))],
    );
    const rows = visible.map((candidate) => {
      const record = chunks.get(candidate.chunk_id)?.find(
        (message) => message.id === candidate.id,
      );
      if (!record || record.timestamp !== Number(candidate.timestamp)) {
        throw new Error(`Legacy cold catalog entry ${candidate.id} is invalid`);
      }
      return record;
    });
    return { rows, hasMore: candidates.rows.length === limit };
  }

  private async compactCandidates(
    args: {
      channelId?: string;
      afterTimestamp?: number;
      cursor?: ColdArchiveCursor;
      imagesOnly: boolean;
    },
    limit: number,
  ): Promise<ColdCandidatePage> {
    const values: unknown[] = [];
    const conditions = ["chunk.compact_indexed = true", "chunk.active_message_count > 0"];
    if (args.channelId) {
      values.push(args.channelId);
      conditions.push(`chunk.channel_key = (SELECT storage_key FROM channels WHERE id = $${values.length})`);
    }
    if (args.afterTimestamp) {
      values.push(args.afterTimestamp);
      conditions.push(`chunk.last_timestamp > $${values.length}`);
    }
    if (args.cursor) {
      values.push(args.cursor.timestamp);
      conditions.push(`chunk.first_timestamp <= $${values.length}`);
    }
    if (args.imagesOnly) {
      conditions.push("chunk.image_message_count > 0");
      conditions.push("chunk.image_projection_indexed = false");
    }
    const metadata = await this.database.query<CompactChunkMeta>(`
      SELECT chunk.id, chunk.first_timestamp, chunk.last_timestamp
      FROM chat_message_cold_chunks AS chunk
      WHERE ${conditions.join(" AND ")}
      ORDER BY chunk.last_timestamp DESC, chunk.id DESC
    `, values);
    const streams: Array<{ rows: ArchivedMessageRow[]; index: number }> = [];
    const output: ArchivedMessageRow[] = [];
    let metadataIndex = 0;

    while (output.length < limit) {
      let best = bestStream(streams);
      while (
        metadataIndex < metadata.rows.length &&
        (!best || Number(metadata.rows[metadataIndex].last_timestamp) >= best.row.timestamp)
      ) {
        const meta = metadata.rows[metadataIndex++];
        const records = (await this.loadChunks([meta.id])).get(meta.id) ?? [];
        const eligible = records.filter((record) => isCompactCandidate(record, args));
        if (eligible.length > 0) streams.push({ rows: eligible, index: eligible.length - 1 });
        best = bestStream(streams);
      }
      if (!best) break;
      output.push(best.row);
      best.stream.index -= 1;
    }
    return {
      rows: output.slice(0, limit - 1),
      hasMore:
        output.length === limit ||
        metadataIndex < metadata.rows.length ||
        streams.some((stream) => stream.index >= 0),
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
      return true;
    });
  }

  private async performRun(): Promise<ColdArchiveRunResult> {
    const chunksMigrated = await this.migrateLegacyChunks(MAX_LEGACY_MIGRATIONS_PER_RUN);
    const enabled = await this.isEnabled();
    if (!enabled) {
      return { enabled, chunksCreated: 0, chunksMigrated, messagesArchived: 0 };
    }
    const cutoff = startOfUtcDay(Date.now() - RETENTION_DAYS * DAY_MS);
    let chunksCreated = 0;
    let messagesArchived = 0;
    for (let index = 0; index < MAX_ARCHIVE_CHUNKS_PER_RUN; index += 1) {
      const oldest = await this.oldestEligibleGroup(cutoff);
      if (!oldest) break;
      const archived = await this.archiveGroup(
        oldest.channelId,
        oldest.periodStart,
        oldest.channelProfileId,
      );
      chunksCreated += 1;
      messagesArchived += archived;
    }
    const result = { enabled, chunksCreated, chunksMigrated, messagesArchived };
    if (chunksCreated > 0 || chunksMigrated > 0) {
      this.logger?.info(result, "Canonical chat messages moved to cold archive");
    }
    return result;
  }

  private async migrateLegacyChunks(limit: number) {
    const legacy = await this.database.query<{ id: string }>(`
      SELECT id FROM chat_message_cold_chunks
      WHERE compact_indexed = false OR codec <> $2 OR image_projection_indexed = false
      ORDER BY period_start, first_timestamp, id
      LIMIT $1
    `, [limit, CODEC]);
    let migrated = 0;
    for (const row of legacy.rows) {
      const client = await this.database.pool.connect();
      try {
        await client.query("BEGIN");
        const chunkResult = await client.query<ColdChunkRow>(`
          SELECT id, message_count, uncompressed_bytes, compressed_bytes,
                 sha256, payload, compact_indexed, codec
          FROM chat_message_cold_chunks
          WHERE id = $1 FOR UPDATE
        `, [row.id]);
        const chunk = chunkResult.rows[0];
        if (!chunk) {
          await client.query("COMMIT");
          continue;
        }
        const records = await verifyStoredChunk(chunk);
        const catalog = chunk.compact_indexed ? undefined : await client.query<{
          id: string;
          external_message_id: string;
          channel_id: string;
          timestamp: string;
          has_images: boolean;
          deleted_at: string | null;
        }>(`
          SELECT catalog.id, catalog.external_message_id,
                 channel.id AS channel_id, catalog.timestamp,
                 catalog.has_images, catalog.deleted_at
          FROM chat_message_cold_catalog AS catalog
          JOIN channels AS channel ON channel.storage_key = catalog.channel_key
          WHERE catalog.chunk_id = $1
        `, [row.id]);
        if (catalog) verifyLegacyCatalog(row.id, records, catalog.rows);
        if (chunk.codec !== CODEC) {
          const encoded = await encodeColdMessageChunk(records);
          const verified = await verifyColdMessageChunk(encoded.payload, {
            sha256: encoded.sha256,
            messageCount: records.length,
            uncompressedBytes: encoded.uncompressedBytes,
          });
          if (JSON.stringify(verified) !== JSON.stringify(records)) {
            throw new Error(`Cold chunk ${row.id} changed while re-encoding`);
          }
          await client.query(`
            UPDATE chat_message_cold_chunks
            SET codec=$2, uncompressed_bytes=$3, compressed_bytes=$4,
                sha256=$5, payload=$6
            WHERE id=$1
          `, [row.id, CODEC, encoded.uncompressedBytes, encoded.compressedBytes,
            encoded.sha256, encoded.payload]);
        }
        await this.writeCompactIndexes(client, row.id, records);
        if (catalog) {
          const deleted = await client.query(
            "DELETE FROM chat_message_cold_catalog WHERE chunk_id = $1",
            [row.id],
          );
          if (deleted.rowCount !== records.length) {
            throw new Error(`Legacy cold catalog ${row.id} changed during migration`);
          }
        }
        await client.query("COMMIT");
        migrated += 1;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }
    return migrated;
  }

  async reindexImages(options: {
    isCancelled?: () => Promise<boolean>;
    onProgress?: (processed: number) => Promise<void>;
    remoteImageDetector?: RemoteImageDetectorLike;
  } = {}) {
    const chunks = await this.database.query<{ id: string; compact_indexed: boolean }>(`
      SELECT id, compact_indexed FROM chat_message_cold_chunks
      ORDER BY period_start, first_timestamp, id
    `);
    let processed = 0;
    let changed = 0;
    for (const chunk of chunks.rows) {
      if (await options.isCancelled?.()) break;
      const records = await this.activeRecordsForChunk(chunk);
      const messageIds = new Set(records.map((record) => record.id));
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
      changed += await this.mutateKnownChunk(
        chunk.id,
        messageIds,
        (record) => {
          const imageUrls = mergeIndexedImageUrls(
            record.message_text,
            [...(record.image_urls ?? []), ...(resolvedById.get(record.id) ?? [])],
            record.hidden_image_urls,
          );
          const hasImages = imageUrls.length > 0;
          const isChanged =
            JSON.stringify(record.image_urls ?? []) !== JSON.stringify(imageUrls) ||
            record.has_images !== hasImages ||
            record.image_index_version !== IMAGE_INDEX_VERSION;
          if (!isChanged) return false;
          record.image_urls = imageUrls;
          record.has_images = hasImages;
          record.image_index_version = IMAGE_INDEX_VERSION;
          return true;
        },
      );
      processed += records.length;
      await options.onProgress?.(processed);
    }
    return { processed, changed };
  }

  async deduplicateImages(options: {
    isCancelled?: () => Promise<boolean>;
  } = {}): Promise<ImageDeduplicationResult> {
    const owners = new Map<string, ImageOwner>();
    const chunks = await this.database.query<{ id: string; compact_indexed: boolean }>(`
      SELECT id, compact_indexed FROM chat_message_cold_chunks
      ORDER BY period_start, first_timestamp, id
    `);
    let scanned = 0;
    for (const chunk of chunks.rows) {
      if (await options.isCancelled?.()) return { changed: 0, removed: 0, scanned };
      const records = await this.activeRecordsForChunk(chunk);
      for (const record of records) {
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
                has_images = $4
            WHERE id = $1 AND deleted_at IS NULL
          `, [
            record.id,
            deduplicated.imageUrls.length > 0
              ? JSON.stringify(deduplicated.imageUrls)
              : null,
            hiddenImageUrls.length > 0 ? JSON.stringify(hiddenImageUrls) : null,
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
      const records = await this.activeRecordsForChunk(chunk);
      const removedByMessage = new Map<string, number>();
      const chunkChanged = await this.mutateKnownChunk(
        chunk.id,
        new Set(records.map((record) => record.id)),
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
      SELECT id, message_count, uncompressed_bytes, compressed_bytes, sha256,
             payload, compact_indexed, active_message_count, image_message_count
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
      const compactIssue = chunk.compact_indexed
        ? await this.compactIntegrityIssue(chunk, records)
        : undefined;
      const catalog = chunk.compact_indexed ? undefined : await this.database.query<{
        id: string;
        channel_id: string;
        timestamp: string;
        has_images: boolean;
        deleted_at: string | null;
      }>(`
          SELECT catalog.id, channel.id AS channel_id, catalog.timestamp,
                 catalog.has_images, catalog.deleted_at
          FROM chat_message_cold_catalog AS catalog
          JOIN channels AS channel ON channel.storage_key = catalog.channel_key
          WHERE catalog.chunk_id = $1
        `, [chunk.id]);
      const catalogById = new Map(catalog?.rows.map((row) => [row.id, row]) ?? []);
      if (compactIssue) {
        checked += records.length;
        issues.push({ id: chunk.id, issue: compactIssue });
        if (issues.length >= issueLimit) return { checked, issues };
        continue;
      }
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
        if (!chunk.compact_indexed && (
          !entry ||
          entry.channel_id !== record.channel_id ||
          Number(entry.timestamp) !== record.timestamp ||
          entry.has_images !== record.has_images ||
          catalogDeletedAt !== record.deleted_at
        )) {
          issues.push({ id: record.id, issue: "Cold catalog does not match its archive record" });
        } else if (
          JSON.stringify(record.image_urls ?? []) !== JSON.stringify(expectedImages) ||
          record.has_images !== (expectedImages.length > 0)
        ) {
          issues.push({ id: record.id, issue: "Cold image metadata does not match indexed URLs" });
        }
        if (issues.length >= issueLimit) return { checked, issues };
      }
      if (catalog && catalog.rows.length !== records.length && issues.length < issueLimit) {
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
      channel_profile_id: number;
      period_start: string;
      raw_pending: boolean;
    }>(`
      SELECT channel.id AS channel_id, message.channel_profile_id,
             (message.timestamp / $2::bigint) * $2::bigint AS period_start,
             EXISTS (
               SELECT 1 FROM chat_raw_events AS raw
               WHERE raw.external_message_id = message.external_message_id
             ) AS raw_pending
      FROM chat_messages AS message
      JOIN channels AS channel ON channel.storage_key = message.channel_key
      WHERE timestamp < $1
      ORDER BY message.timestamp, message.channel_key
      LIMIT 1
    `, [cutoff, DAY_MS]);
    const row = result.rows[0];
    if (!row) return undefined;
    if (row.raw_pending) {
      throw new Error(
        "An eligible canonical message still has an unarchived raw event; cold archival paused",
      );
    }
    return {
      channelId: row.channel_id,
      channelProfileId: Number(row.channel_profile_id),
      periodStart: Number(row.period_start),
    };
  }

  private async archiveGroup(
    channelId: string,
    periodStart: number,
    channelProfileId: number,
  ) {
    const periodEnd = periodStart + DAY_MS;
    const source = await this.database.query<ArchivedMessageDatabaseRow>(`
      SELECT
        id, channel_id, platform, external_message_id,
        external_channel_id, channel_name, sender_id,
        sender_username, sender_display_name, message_text, has_images, image_urls,
        image_index_version, timestamp, badges, user_color,
        is_broadcaster, is_moderator, is_subscriber, is_vip, message_type,
        native_emotes, hidden_image_urls, deleted_at, sender_profile_id
      FROM chat_messages_expanded
      WHERE channel_id = $1 AND timestamp >= $2 AND timestamp < $3
        AND channel_profile_id = $5
        AND NOT EXISTS (
          SELECT 1 FROM chat_raw_events AS raw
          WHERE raw.external_message_id = chat_messages_expanded.external_message_id
        )
      ORDER BY timestamp, id
      LIMIT $4
    `, [channelId, periodStart, periodEnd, MAX_CHUNK_MESSAGES, channelProfileId]);
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
          id, channel_key, period_start, period_end, first_timestamp,
          last_timestamp, message_count, codec, uncompressed_bytes,
          compressed_bytes, sha256, payload, created_at, compact_indexed,
          active_message_count, image_message_count
        ) SELECT $1, storage_key, $3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
                 false,NULL,NULL
          FROM channels WHERE id = $2
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
      await this.writeCompactIndexes(client, chunkId, records);
      const deleted = await client.query(`
        DELETE FROM chat_messages WHERE id = ANY($1::text[])
      `, [records.map((record) => record.id)]);
      if (deleted.rowCount !== records.length) {
        throw new Error(
          `Canonical source changed during archival: expected ${records.length}, removed ${deleted.rowCount ?? 0}`,
        );
      }
      await client.query("COMMIT");
      this.cacheChunk(chunkId, records);
      return records.length;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async writeCompactIndexes(
    client: PoolClient,
    chunkId: string,
    records: ArchivedMessageRow[],
  ) {
    const externalMessageIds = records.map((record) => record.external_message_id);
    await client.query("SELECT pg_advisory_xact_lock($1)", [1_987_042_020]);
    const duplicate = await client.query<{ chunk_id: string }>(`
      SELECT chunk_id FROM find_cold_message_chunks($2::uuid[])
      WHERE chunk_id <> $1
      LIMIT 1
    `, [chunkId, externalMessageIds]);
    if (duplicate.rowCount) {
      throw new Error("A compact cold chunk contains an already archived Twitch message");
    }
    await client.query(
      "DELETE FROM chat_message_cold_chunk_keys WHERE chunk_id = $1",
      [chunkId],
    );
    await client.query(`
      INSERT INTO chat_message_cold_chunk_keys (chunk_id, external_message_ids)
      VALUES ($1, $2::uuid[])
    `, [chunkId, externalMessageIds]);

    const stats = buildSenderStats(records);
    await client.query(
      "DELETE FROM chat_message_cold_sender_stats_legacy WHERE chunk_id = $1",
      [chunkId],
    );
    await client.query(
      "DELETE FROM chat_message_cold_sender_stats WHERE chunk_id = $1",
      [chunkId],
    );
    if (stats.length > 0 && stats.every((stat) => stat.senderProfileId !== null)) {
      await client.query(`
        INSERT INTO chat_message_cold_sender_stats (
          chunk_id, sender_profile_id, message_count, last_timestamp
        )
        SELECT $1, * FROM unnest($2::integer[], $3::integer[], $4::bigint[])
      `, [
        chunkId,
        stats.map((stat) => stat.senderProfileId),
        stats.map((stat) => stat.messageCount),
        stats.map((stat) => stat.lastTimestamp),
      ]);
    } else if (stats.length > 0) {
      await client.query(`
        INSERT INTO chat_message_cold_sender_stats_legacy (
          chunk_id, sender_profile_id, sender_username, sender_display_name,
          message_count, last_timestamp
        )
        SELECT $1, *
        FROM unnest(
          $2::bigint[], $3::text[], $4::text[], $5::integer[], $6::bigint[]
        )
      `, [
        chunkId,
        stats.map((stat) => stat.senderProfileId),
        stats.map((stat) => stat.senderUsername),
        stats.map((stat) => stat.senderDisplayName),
        stats.map((stat) => stat.messageCount),
        stats.map((stat) => stat.lastTimestamp),
      ]);
    }
    await client.query("DELETE FROM chat_message_cold_images WHERE chunk_id = $1", [chunkId]);
    const imageRecords = records.filter(
      (record) => record.deleted_at === null && record.has_images,
    );
    if (imageRecords.length > 0) {
      await client.query(`
        INSERT INTO chat_message_cold_images (id, chunk_id, channel_key, timestamp, record)
        SELECT item.id, $1, channel.storage_key, item.timestamp, item.record
        FROM unnest($2::text[], $3::text[], $4::bigint[], $5::jsonb[]) AS item(id, channel_id, timestamp, record)
        JOIN channels AS channel ON channel.id = item.channel_id
      `, [
        chunkId,
        imageRecords.map((record) => record.id),
        imageRecords.map((record) => record.channel_id),
        imageRecords.map((record) => record.timestamp),
        imageRecords.map((record) => JSON.stringify(record)),
      ]);
    }
    const activeMessageCount = records.filter((record) => record.deleted_at === null).length;
    const imageMessageCount = records.filter(
      (record) => record.deleted_at === null && record.has_images,
    ).length;
    const updated = await client.query(`
      UPDATE chat_message_cold_chunks
      SET compact_indexed = true,
          active_message_count = $2,
          image_message_count = $3,
          image_projection_indexed = true
      WHERE id = $1
    `, [chunkId, activeMessageCount, imageMessageCount]);
    if (updated.rowCount !== 1) throw new Error(`Cold chunk ${chunkId} disappeared`);
    const verified = await client.query<{
      external_count: string;
      sender_count: string;
    }>(`
      SELECT
        cardinality(keys.external_message_ids)::bigint AS external_count,
        COALESCE(sum(stats.message_count), 0)::bigint AS sender_count
      FROM chat_message_cold_chunk_keys AS keys
      LEFT JOIN (
        SELECT chunk_id, message_count FROM chat_message_cold_sender_stats_legacy
        UNION ALL
        SELECT chunk_id, message_count FROM chat_message_cold_sender_stats
      ) AS stats ON stats.chunk_id = keys.chunk_id
      WHERE keys.chunk_id = $1
      GROUP BY keys.external_message_ids
    `, [chunkId]);
    if (
      Number(verified.rows[0]?.external_count ?? -1) !== records.length ||
      Number(verified.rows[0]?.sender_count ?? -1) !== activeMessageCount
    ) {
      throw new Error(`Compact cold indexes for ${chunkId} failed verification`);
    }
  }

  private async compactIntegrityIssue(
    chunk: ColdChunkRow,
    records: ArchivedMessageRow[],
  ) {
    const keys = await this.database.query<{ external_message_ids: string[] }>(`
      SELECT external_message_ids
      FROM chat_message_cold_chunk_keys
      WHERE chunk_id = $1
    `, [chunk.id]);
    const externalIds = keys.rows[0]?.external_message_ids ?? [];
    const expectedExternalIds = new Set(
      records.map((record) => record.external_message_id.toLowerCase()),
    );
    if (
      externalIds.length !== records.length ||
      externalIds.some((id) => !expectedExternalIds.has(id.toLowerCase()))
    ) {
      return "Compact cold external-ID index does not match its archive";
    }
    const active = records.filter((record) => record.deleted_at === null);
    if (
      Number(chunk.active_message_count) !== active.length ||
      Number(chunk.image_message_count) !== active.filter((record) => record.has_images).length
    ) {
      return "Compact cold chunk counts do not match its archive";
    }
    const expectedStats = buildSenderStats(records).map(senderStatSignature).sort();
    const stats = await this.database.query<{
      sender_profile_id: string | null;
      sender_username: string | null;
      sender_display_name: string | null;
      message_count: number;
      last_timestamp: string;
    }>(`
      SELECT sender_profile_id, sender_username, sender_display_name,
             message_count, last_timestamp
      FROM chat_message_cold_sender_stats_legacy
      WHERE chunk_id = $1
      UNION ALL
      SELECT sender_profile_id, NULL, NULL, message_count, last_timestamp
      FROM chat_message_cold_sender_stats
      WHERE chunk_id = $1
    `, [chunk.id]);
    const actualStats = stats.rows.map((stat) => senderStatSignature({
      senderProfileId:
        stat.sender_profile_id === null ? null : Number(stat.sender_profile_id),
      senderUsername: stat.sender_username,
      senderDisplayName: stat.sender_display_name,
      messageCount: Number(stat.message_count),
      lastTimestamp: Number(stat.last_timestamp),
    })).sort();
    if (JSON.stringify(actualStats) !== JSON.stringify(expectedStats)) {
      return "Compact cold sender statistics do not match its archive";
    }
    const projected = await this.database.query<{ id: string; record: ArchivedMessageRow }>(`
      SELECT id, record FROM chat_message_cold_images WHERE chunk_id = $1 ORDER BY id
    `, [chunk.id]);
    const expectedProjection = active.filter((record) => record.has_images)
      .sort((left, right) => left.id.localeCompare(right.id));
    if (
      projected.rows.length !== expectedProjection.length ||
      projected.rows.some((row, index) =>
        row.id !== expectedProjection[index]?.id ||
        stableJson(row.record) !== stableJson(expectedProjection[index]))
    ) {
      return "Sparse cold image projection does not match its archive";
    }
    const legacy = await this.database.query(`
      SELECT 1 FROM chat_message_cold_catalog WHERE chunk_id = $1 LIMIT 1
    `, [chunk.id]);
    return legacy.rowCount ? "Compact cold chunk still has legacy catalog rows" : undefined;
  }

  private async activeRecordsForChunk(chunk: { id: string; compact_indexed: boolean }) {
    const records = (await this.loadChunks([chunk.id])).get(chunk.id) ?? [];
    if (chunk.compact_indexed) {
      return records.filter((record) => record.deleted_at === null);
    }
    const active = await this.database.query<{ id: string }>(`
      SELECT id FROM chat_message_cold_catalog
      WHERE chunk_id = $1 AND deleted_at IS NULL
    `, [chunk.id]);
    const activeIds = new Set(active.rows.map((row) => row.id));
    return records.filter((record) => activeIds.has(record.id));
  }

  private async loadChunks(chunkIds: string[]) {
    const loaded = new Map<string, ArchivedMessageRow[]>();
    const missing = chunkIds.filter((id) => {
      const cached = this.decodedChunks.get(id);
      if (cached) {
        this.cacheMetrics.hits += 1;
        this.decodedChunks.delete(id);
        this.decodedChunks.set(id, cached);
        loaded.set(id, cached);
      } else {
        this.cacheMetrics.misses += 1;
      }
      return !cached;
    });
    if (missing.length > 0) {
      const result = await this.database.query<ColdChunkRow>(`
        SELECT id, message_count, uncompressed_bytes, compressed_bytes, sha256, payload
        FROM chat_message_cold_chunks
        WHERE id = ANY($1::uuid[])
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

    const unresolved = new Set(
      messageIds.filter((id) => ![...idsByChunk.values()].some((ids) => ids.has(id))),
    );
    if (unresolved.size > 0) {
      const compact = await this.database.query<{ id: string }>(`
        SELECT id FROM chat_message_cold_chunks
        WHERE compact_indexed = true
        ORDER BY period_start, first_timestamp, id
      `);
      for (const chunk of compact.rows) {
        if (unresolved.size === 0) break;
        const records = (await this.loadChunks([chunk.id])).get(chunk.id) ?? [];
        const matches = new Set(
          records.filter((record) => unresolved.has(record.id)).map((record) => record.id),
        );
        if (matches.size === 0) continue;
        idsByChunk.set(chunk.id, matches);
        for (const id of matches) unresolved.delete(id);
      }
    }

    let changed = 0;
    for (const [chunkId, ids] of idsByChunk) {
      changed += await this.mutateKnownChunk(chunkId, ids, mutate);
    }
    return changed;
  }

  private async mutateKnownChunk(
    chunkId: string,
    ids: Set<string>,
    mutate: (record: ArchivedMessageRow) => boolean,
  ) {
    const client = await this.database.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<ColdChunkRow>(`
        SELECT id, message_count, uncompressed_bytes, compressed_bytes,
               sha256, payload, compact_indexed
        FROM chat_message_cold_chunks
        WHERE id = $1 FOR UPDATE
      `, [chunkId]);
      const chunk = result.rows[0];
      if (!chunk) throw new Error(`Cold archive chunk ${chunkId} is missing`);
      const records = await verifyStoredChunk(chunk);
      let changed = 0;
      for (const record of records) {
        if (ids.has(record.id) && mutate(record)) changed += 1;
      }
      if (changed > 0) {
        const encoded = await encodeColdMessageChunk(records);
        await verifyColdMessageChunk(encoded.payload, {
          sha256: encoded.sha256,
          messageCount: records.length,
          uncompressedBytes: encoded.uncompressedBytes,
        });
        await client.query(`
          UPDATE chat_message_cold_chunks
          SET codec=$2, uncompressed_bytes=$3, compressed_bytes=$4, sha256=$5, payload=$6
          WHERE id=$1
        `, [
          chunkId,
          CODEC,
          encoded.uncompressedBytes,
          encoded.compressedBytes,
          encoded.sha256,
          encoded.payload,
        ]);
        if (chunk.compact_indexed) {
          await this.writeCompactIndexes(client, chunkId, records);
        } else {
          for (const record of records.filter((candidate) => ids.has(candidate.id))) {
            await client.query(`
              UPDATE chat_message_cold_catalog
              SET deleted_at=$2, has_images=$3
              WHERE id=$1
            `, [record.id, record.deleted_at, record.has_images]);
          }
        }
      }
      await client.query("COMMIT");
      if (changed > 0) this.cacheChunk(chunkId, records);
      return changed;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private cacheChunk(chunkId: string, records: ArchivedMessageRow[]) {
    const previousBytes = this.decodedChunkBytes.get(chunkId) ?? 0;
    this.decodedChunks.delete(chunkId);
    this.decodedChunkBytes.delete(chunkId);
    this.cachedBytes -= previousBytes;
    const bytes = Buffer.byteLength(JSON.stringify(records), "utf8");
    this.decodedChunks.set(chunkId, records);
    this.decodedChunkBytes.set(chunkId, bytes);
    this.cachedBytes += bytes;
    while (
      this.decodedChunks.size > this.maxCacheChunks ||
      (this.cachedBytes > this.maxCacheBytes && this.decodedChunks.size > 1)
    ) {
      const oldest = this.decodedChunks.keys().next().value!;
      this.decodedChunks.delete(oldest);
      this.cachedBytes -= this.decodedChunkBytes.get(oldest) ?? 0;
      this.decodedChunkBytes.delete(oldest);
      this.cacheMetrics.evictions += 1;
    }
  }
}

function isCompactCandidate(
  record: ArchivedMessageRow,
  args: {
    afterTimestamp?: number;
    cursor?: ColdArchiveCursor;
    imagesOnly: boolean;
  },
) {
  if (record.deleted_at !== null) return false;
  if (args.afterTimestamp && record.timestamp <= args.afterTimestamp) return false;
  if (args.imagesOnly && !record.has_images) return false;
  if (args.cursor && !isOlderThan(record, args.cursor)) return false;
  return true;
}

function isOlderThan(
  record: Pick<ArchivedMessageRow, "timestamp" | "id">,
  cursor: ColdArchiveCursor,
) {
  return record.timestamp < cursor.timestamp ||
    (record.timestamp === cursor.timestamp && record.id < cursor.id);
}

function isNewer(
  left: Pick<ArchivedMessageRow, "timestamp" | "id">,
  right: Pick<ArchivedMessageRow, "timestamp" | "id">,
) {
  return left.timestamp > right.timestamp ||
    (left.timestamp === right.timestamp && left.id > right.id);
}

function bestStream(streams: Array<{ rows: ArchivedMessageRow[]; index: number }>) {
  let selected:
    | { stream: { rows: ArchivedMessageRow[]; index: number }; row: ArchivedMessageRow }
    | undefined;
  for (const stream of streams) {
    if (stream.index < 0) continue;
    const row = stream.rows[stream.index];
    if (!selected || isNewer(row, selected.row)) selected = { stream, row };
  }
  return selected;
}

function mergeCandidateRows(
  left: ArchivedMessageRow[],
  right: ArchivedMessageRow[],
  limit: number,
) {
  const rows: ArchivedMessageRow[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (rows.length < limit && (leftIndex < left.length || rightIndex < right.length)) {
    const leftRow = left[leftIndex];
    const rightRow = right[rightIndex];
    if (leftRow && (!rightRow || isNewer(leftRow, rightRow))) {
      rows.push(leftRow);
      leftIndex += 1;
    } else if (rightRow) {
      rows.push(rightRow);
      rightIndex += 1;
    }
  }
  return rows;
}

function buildSenderStats(records: ArchivedMessageRow[]): ColdSenderStat[] {
  const stats = new Map<string, ColdSenderStat>();
  for (const record of records) {
    if (record.deleted_at !== null) continue;
    const senderProfileId = record.sender_profile_id === undefined
      ? null
      : Number(record.sender_profile_id);
    const key = senderProfileId === null
      ? `legacy:${record.sender_username}\u0000${record.sender_display_name}`
      : `profile:${senderProfileId}`;
    const existing = stats.get(key);
    if (existing) {
      existing.messageCount += 1;
      existing.lastTimestamp = Math.max(existing.lastTimestamp, record.timestamp);
      continue;
    }
    stats.set(key, {
      senderProfileId,
      senderUsername: senderProfileId === null ? record.sender_username : null,
      senderDisplayName: senderProfileId === null ? record.sender_display_name : null,
      messageCount: 1,
      lastTimestamp: record.timestamp,
    });
  }
  return [...stats.values()];
}

function senderStatSignature(stat: ColdSenderStat) {
  return JSON.stringify([
    stat.senderProfileId,
    stat.senderUsername,
    stat.senderDisplayName,
    stat.messageCount,
    stat.lastTimestamp,
  ]);
}

function verifyLegacyCatalog(
  chunkId: string,
  records: ArchivedMessageRow[],
  rows: Array<{
    id: string;
    external_message_id: string;
    channel_id: string;
    timestamp: string;
    has_images: boolean;
    deleted_at: string | null;
  }>,
) {
  if (rows.length !== records.length) {
    throw new Error(`Legacy cold catalog ${chunkId} count does not match its archive`);
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const record of records) {
    const row = byId.get(record.id);
    if (
      !row ||
      row.external_message_id !== record.external_message_id ||
      row.channel_id !== record.channel_id ||
      Number(row.timestamp) !== record.timestamp ||
      row.has_images !== record.has_images ||
      (row.deleted_at === null ? null : Number(row.deleted_at)) !== record.deleted_at
    ) {
      throw new Error(`Legacy cold catalog ${chunkId} metadata is inconsistent`);
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
  const uncompressed = Buffer.from(JSON.stringify(toV3Chunk(records)), "utf8");
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
  const records = text.startsWith("[")
    ? fromV3Chunk(JSON.parse(text) as V3Chunk)
    : text.length === 0
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
    hidden_image_urls: row.hidden_image_urls ?? [],
    image_index_version:
      row.image_index_version === null ? null : Number(row.image_index_version),
    timestamp: Number(row.timestamp),
    deleted_at: row.deleted_at === null ? null : Number(row.deleted_at),
  };
}

function startOfUtcDay(timestamp: number) {
  return Math.floor(timestamp / DAY_MS) * DAY_MS;
}

function asError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

type V3Profile = [string | number | null, string, string, string, string | null];
type V3Row = [
  string, string, number, string, string[] | null, number | null, number,
  number, number, number, NativeEmote[] | null, string[] | null,
  number | null, number, Record<string, unknown> | null,
];
type V3Chunk = [
  3,
  [string, string, string, string],
  V3Profile[],
  ArchivedMessageRow["badges"][],
  string[],
  number,
  V3Row[],
];

function toV3Chunk(records: ArchivedMessageRow[]): V3Chunk {
  const first = records[0];
  const channel: V3Chunk[1] = [
    first.channel_id,
    first.platform,
    first.external_channel_id,
    first.channel_name,
  ];
  const profiles: V3Profile[] = [];
  const profileIndexes = new Map<string, number>();
  const badges: ArchivedMessageRow["badges"][] = [];
  const badgeIndexes = new Map<string, number>();
  const messageTypes: string[] = [];
  const messageTypeIndexes = new Map<string, number>();
  const baseTimestamp = first.timestamp;
  const indexOf = <T>(values: T[], indexes: Map<string, number>, value: T) => {
    const key = JSON.stringify(value);
    const existing = indexes.get(key);
    if (existing !== undefined) return existing;
    const index = values.length;
    values.push(value);
    indexes.set(key, index);
    return index;
  };
  const rows = records.map((record): V3Row => {
    if (
      record.channel_id !== channel[0] || record.platform !== channel[1] ||
      record.external_channel_id !== channel[2] || record.channel_name !== channel[3]
    ) throw new Error("Cold-message chunks cannot span channels or channel profiles");
    const profile: V3Profile = [
      record.sender_profile_id ?? null,
      record.sender_id,
      record.sender_username,
      record.sender_display_name,
      record.user_color,
    ];
    const roleFlags =
      (record.is_broadcaster ? 1 : 0) |
      (record.is_moderator ? 2 : 0) |
      (record.is_subscriber ? 4 : 0) |
      (record.is_vip ? 8 : 0);
    let presence = 0;
    const extras: Record<string, unknown> = {};
    for (const [bit, key] of [
      [1, "event_notification_id"],
      [2, "gallery_channel_id"],
      [4, "metadata"],
      [8, "created_at"],
    ] as const) {
      if (Object.hasOwn(record, key)) {
        presence |= bit;
        extras[key] = record[key];
      }
    }
    if (Object.hasOwn(record, "native_emotes")) presence |= 16;
    if (Object.hasOwn(record, "sender_profile_id")) presence |= 32;
    return [
      record.id,
      record.external_message_id,
      indexOf(profiles, profileIndexes, profile),
      record.message_text,
      record.image_urls,
      record.image_index_version,
      record.timestamp - baseTimestamp,
      indexOf(badges, badgeIndexes, record.badges),
      roleFlags,
      indexOf(messageTypes, messageTypeIndexes, record.message_type),
      record.native_emotes ?? null,
      record.hidden_image_urls.length > 0 ? record.hidden_image_urls : null,
      record.deleted_at === null ? null : record.deleted_at - baseTimestamp,
      presence,
      Object.keys(extras).length > 0 ? extras : null,
    ];
  });
  return [3, channel, profiles, badges, messageTypes, baseTimestamp, rows];
}

function fromV3Chunk(chunk: V3Chunk): ArchivedMessageRow[] {
  if (!Array.isArray(chunk) || chunk[0] !== 3) {
    throw new Error("Unsupported positional cold-message codec");
  }
  const [, channel, profiles, badges, messageTypes, baseTimestamp, rows] = chunk;
  return rows.map((row) => {
    const profile = profiles[row[2]];
    if (!profile || !badges[row[7]] || messageTypes[row[9]] === undefined) {
      throw new Error("Cold-message dictionary index is invalid");
    }
    const record: ArchivedMessageRow = {
      id: row[0],
      channel_id: channel[0],
      platform: channel[1],
      external_message_id: row[1],
      external_channel_id: channel[2],
      channel_name: channel[3],
      sender_id: profile[1],
      sender_username: profile[2],
      sender_display_name: profile[3],
      message_text: row[3],
      has_images: (row[4]?.length ?? 0) > 0,
      image_urls: row[4],
      image_index_version: row[5],
      timestamp: baseTimestamp + row[6],
      badges: badges[row[7]],
      user_color: profile[4],
      is_broadcaster: (row[8] & 1) !== 0,
      is_moderator: (row[8] & 2) !== 0,
      is_subscriber: (row[8] & 4) !== 0,
      is_vip: (row[8] & 8) !== 0,
      message_type: messageTypes[row[9]],
      hidden_image_urls: row[11] ?? [],
      deleted_at: row[12] === null ? null : baseTimestamp + row[12],
    };
    if (row[13] & 16) record.native_emotes = row[10];
    if (row[13] & 32) record.sender_profile_id = profile[0]!;
    if (row[14]) Object.assign(record, row[14]);
    return record;
  });
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
