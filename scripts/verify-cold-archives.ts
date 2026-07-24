import "dotenv/config";
import { PostgresDatabase } from "../worker/database";
import { verifyColdMessageChunk } from "../worker/ColdMessageArchiveService";

interface ChunkRow {
  id: string;
  message_count: string;
  uncompressed_bytes: string;
  compressed_bytes: string;
  sha256: string;
  payload: Buffer;
}

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const database = new PostgresDatabase(databaseUrl);
try {
  const chunks = await database.query<ChunkRow>(`
    SELECT id, message_count, uncompressed_bytes, compressed_bytes, sha256, payload
    FROM chat_message_cold_chunks
    ORDER BY period_start, first_timestamp, id
  `);
  const seenIds = new Set<string>();
  const seenExternalIds = new Set<string>();
  let archivedMessages = 0;
  let uncompressedBytes = 0;
  let compressedBytes = 0;

  for (const chunk of chunks.rows) {
    if (chunk.payload.length !== Number(chunk.compressed_bytes)) {
      throw new Error(`Cold chunk ${chunk.id} compressed size does not match its manifest`);
    }
    const records = await verifyColdMessageChunk(chunk.payload, {
      sha256: chunk.sha256,
      messageCount: Number(chunk.message_count),
      uncompressedBytes: Number(chunk.uncompressed_bytes),
    });
    const catalog = await database.query<{
      id: string;
      external_message_id: string;
      channel_id: string;
      timestamp: string;
      has_images: boolean;
      deleted_at: string | null;
    }>(`
      SELECT id, external_message_id, channel_id, timestamp, has_images, deleted_at
      FROM chat_message_cold_catalog
      WHERE chunk_id = $1
      ORDER BY timestamp, id
    `, [chunk.id]);
    if (catalog.rows.length !== records.length) {
      throw new Error(`Cold chunk ${chunk.id} catalog count does not match its manifest`);
    }
    const catalogById = new Map(catalog.rows.map((row) => [row.id, row]));
    for (const record of records) {
      if (seenIds.has(record.id) || seenExternalIds.has(record.external_message_id)) {
        throw new Error(`Cold archive contains duplicate message ${record.id}`);
      }
      seenIds.add(record.id);
      seenExternalIds.add(record.external_message_id);
      const entry = catalogById.get(record.id);
      if (
        !entry ||
        entry.external_message_id !== record.external_message_id ||
        entry.channel_id !== record.channel_id ||
        Number(entry.timestamp) !== record.timestamp ||
        entry.has_images !== record.has_images ||
        (entry.deleted_at === null ? null : Number(entry.deleted_at)) !== record.deleted_at
      ) {
        throw new Error(`Cold catalog metadata does not match archived message ${record.id}`);
      }
    }
    archivedMessages += records.length;
    uncompressedBytes += Number(chunk.uncompressed_bytes);
    compressedBytes += chunk.payload.length;
  }

  const state = await database.query<{ enabled: boolean }>(`
    SELECT COALESCE((
      SELECT enabled FROM archive_settings WHERE key = 'cold_message_archive'
    ), false) AS enabled
  `);
  console.log(JSON.stringify({
    verified: true,
    enabled: state.rows[0].enabled,
    chunks: chunks.rowCount,
    archivedMessages,
    uncompressedBytes,
    compressedBytes,
    compressionRatio: uncompressedBytes === 0 ? null : compressedBytes / uncompressedBytes,
  }, null, 2));
} finally {
  await database.close();
}
