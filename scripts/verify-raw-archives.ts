import "dotenv/config";
import { PostgresDatabase } from "../worker/database";
import { verifyRawArchiveChunk } from "../worker/RawEventArchiveService";

interface ChunkRow {
  id: string;
  message_count: string;
  uncompressed_bytes: string;
  compressed_bytes: string;
  sha256: string;
  payload: Buffer;
  source_cleared_at: string | null;
}

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const database = new PostgresDatabase(databaseUrl);
try {
  const chunks = await database.query<ChunkRow>(`
    SELECT id, message_count, uncompressed_bytes, compressed_bytes,
           sha256, payload, source_cleared_at
    FROM chat_raw_event_chunks
    ORDER BY period_start, first_timestamp, id
  `);
  const seenMessageIds = new Set<string>();
  let archivedMessages = 0;
  let compressedBytes = 0;
  let uncompressedBytes = 0;
  let clearedChunks = 0;

  for (const chunk of chunks.rows) {
    if (chunk.payload.length !== Number(chunk.compressed_bytes)) {
      throw new Error(`Chunk ${chunk.id} compressed size does not match its manifest`);
    }
    const records = await verifyRawArchiveChunk(chunk.payload, {
      sha256: chunk.sha256,
      messageCount: Number(chunk.message_count),
      uncompressedBytes: Number(chunk.uncompressed_bytes),
    });
    for (const record of records) {
      if (seenMessageIds.has(record.externalMessageId)) {
        throw new Error(`Message ${record.externalMessageId} occurs in more than one archive chunk`);
      }
      seenMessageIds.add(record.externalMessageId);
    }
    const source = await database.query<{
      present: string;
      raw_present: string;
    }>(`
      SELECT count(*)::bigint AS present,
             count(raw_message_data)::bigint AS raw_present
      FROM chat_messages
      WHERE external_message_id = ANY($1::text[])
    `, [records.map((record) => record.externalMessageId)]);
    if (Number(source.rows[0].present) !== records.length) {
      throw new Error(`Chunk ${chunk.id} does not have a canonical row for every raw event`);
    }
    const rawPresent = Number(source.rows[0].raw_present);
    if (chunk.source_cleared_at === null && rawPresent !== records.length) {
      throw new Error(`Chunk ${chunk.id} is not marked cleared but a raw source is missing`);
    }
    if (chunk.source_cleared_at !== null && rawPresent !== 0) {
      throw new Error(`Chunk ${chunk.id} is marked cleared but a raw source remains`);
    }
    archivedMessages += records.length;
    compressedBytes += chunk.payload.length;
    uncompressedBytes += Number(chunk.uncompressed_bytes);
    if (chunk.source_cleared_at !== null) clearedChunks += 1;
  }

  const state = await database.query<{
    staged: string;
    source_rows: string;
    cleanup_enabled: boolean;
  }>(`
    SELECT
      (SELECT count(*) FROM chat_raw_events)::bigint AS staged,
      (SELECT count(*) FROM chat_messages WHERE raw_message_data IS NOT NULL)::bigint AS source_rows,
      COALESCE((
        SELECT enabled FROM archive_settings WHERE key = 'raw_source_cleanup'
      ), false) AS cleanup_enabled
  `);
  const current = state.rows[0];
  console.log(JSON.stringify({
    verified: true,
    chunks: chunks.rowCount,
    clearedChunks,
    archivedMessages,
    stagedMessages: Number(current.staged),
    sourceRows: Number(current.source_rows),
    cleanupEnabled: current.cleanup_enabled,
    uncompressedBytes,
    compressedBytes,
    compressionRatio: uncompressedBytes === 0 ? null : compressedBytes / uncompressedBytes,
  }, null, 2));
} finally {
  await database.close();
}
