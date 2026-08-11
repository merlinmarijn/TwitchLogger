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
    const source = await database.query<{ present: string }>(`
      SELECT count(*)::bigint AS present
      FROM unnest($1::text[]) AS source(external_message_id)
      WHERE EXISTS (
        SELECT 1 FROM chat_messages
        WHERE chat_messages.external_message_id = source.external_message_id
      ) OR EXISTS (
        SELECT 1 FROM chat_message_cold_catalog
        WHERE chat_message_cold_catalog.external_message_id = source.external_message_id
      ) OR EXISTS (
        SELECT 1 FROM chat_message_cold_chunk_keys
        WHERE external_message_ids @> ARRAY[source.external_message_id::uuid]
      )
    `, [records.map((record) => record.externalMessageId)]);
    if (Number(source.rows[0].present) !== records.length) {
      throw new Error(`Chunk ${chunk.id} does not have a canonical row for every raw event`);
    }
    archivedMessages += records.length;
    compressedBytes += chunk.payload.length;
    uncompressedBytes += Number(chunk.uncompressed_bytes);
    if (chunk.source_cleared_at !== null) clearedChunks += 1;
  }

  const state = await database.query<{
    staged: string;
  }>(`
    SELECT
      (SELECT count(*) FROM chat_raw_events)::bigint AS staged
  `);
  const current = state.rows[0];
  console.log(JSON.stringify({
    verified: true,
    chunks: chunks.rowCount,
    clearedChunks,
    archivedMessages,
    stagedMessages: Number(current.staged),
    sourceRows: 0,
    uncompressedBytes,
    compressedBytes,
    compressionRatio: uncompressedBytes === 0 ? null : compressedBytes / uncompressedBytes,
  }, null, 2));
} finally {
  await database.close();
}
