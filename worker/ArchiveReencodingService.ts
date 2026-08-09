import type { PoolClient } from "pg";
import {
  encodeColdMessageChunk,
  verifyColdMessageChunk,
} from "./ColdMessageArchiveService";
import {
  encodeRawArchiveChunk,
  verifyRawArchiveChunk,
} from "./RawEventArchiveService";

interface StoredArchiveChunkRow {
  id: string;
  message_count: string;
  uncompressed_bytes: string;
  compressed_bytes: string;
  sha256: string;
  payload: Buffer;
}

export interface ArchiveReencodingResult {
  beforeBytes: number;
  afterBytes: number;
  messageCount: number;
}

export async function reencodeRawArchiveChunk(
  client: PoolClient,
  chunkId: string,
): Promise<ArchiveReencodingResult> {
  const result = await client.query<StoredArchiveChunkRow>(`
    SELECT id, message_count, uncompressed_bytes, compressed_bytes, sha256, payload
    FROM chat_raw_event_chunks
    WHERE id = $1
    FOR UPDATE
  `, [chunkId]);
  const chunk = result.rows[0];
  if (!chunk) throw new Error(`Raw-event archive chunk ${chunkId} is missing`);

  const messageCount = Number(chunk.message_count);
  const uncompressedBytes = Number(chunk.uncompressed_bytes);
  const beforeBytes = Number(chunk.compressed_bytes);
  assertStoredPayloadSize(chunk, beforeBytes);
  const records = await verifyRawArchiveChunk(chunk.payload, {
    sha256: chunk.sha256,
    messageCount,
    uncompressedBytes,
  });
  const encoded = await encodeRawArchiveChunk(records);
  assertUncompressedManifest(chunk, encoded, records.length);
  await verifyRawArchiveChunk(encoded.payload, {
    sha256: encoded.sha256,
    messageCount,
    uncompressedBytes: encoded.uncompressedBytes,
  });
  await client.query(`
    UPDATE chat_raw_event_chunks
    SET compressed_bytes = $2, payload = $3
    WHERE id = $1
  `, [chunkId, encoded.compressedBytes, encoded.payload]);
  return { beforeBytes, afterBytes: encoded.compressedBytes, messageCount };
}

export async function reencodeColdArchiveChunk(
  client: PoolClient,
  chunkId: string,
): Promise<ArchiveReencodingResult> {
  const result = await client.query<StoredArchiveChunkRow>(`
    SELECT id, message_count, uncompressed_bytes, compressed_bytes, sha256, payload
    FROM chat_message_cold_chunks
    WHERE id = $1
    FOR UPDATE
  `, [chunkId]);
  const chunk = result.rows[0];
  if (!chunk) throw new Error(`Cold-message archive chunk ${chunkId} is missing`);

  const messageCount = Number(chunk.message_count);
  const uncompressedBytes = Number(chunk.uncompressed_bytes);
  const beforeBytes = Number(chunk.compressed_bytes);
  assertStoredPayloadSize(chunk, beforeBytes);
  const records = await verifyColdMessageChunk(chunk.payload, {
    sha256: chunk.sha256,
    messageCount,
    uncompressedBytes,
  });
  const encoded = await encodeColdMessageChunk(records);
  assertUncompressedManifest(chunk, encoded, records.length);
  await verifyColdMessageChunk(encoded.payload, {
    sha256: encoded.sha256,
    messageCount,
    uncompressedBytes: encoded.uncompressedBytes,
  });
  await client.query(`
    UPDATE chat_message_cold_chunks
    SET compressed_bytes = $2, payload = $3
    WHERE id = $1
  `, [chunkId, encoded.compressedBytes, encoded.payload]);
  return { beforeBytes, afterBytes: encoded.compressedBytes, messageCount };
}

function assertStoredPayloadSize(chunk: StoredArchiveChunkRow, compressedBytes: number) {
  if (chunk.payload.length !== compressedBytes) {
    throw new Error(`Stored archive chunk ${chunk.id} size does not match its manifest`);
  }
}

function assertUncompressedManifest(
  chunk: StoredArchiveChunkRow,
  encoded: { sha256: string; uncompressedBytes: number },
  messageCount: number,
) {
  if (
    encoded.sha256 !== chunk.sha256 ||
    encoded.uncompressedBytes !== Number(chunk.uncompressed_bytes) ||
    messageCount !== Number(chunk.message_count)
  ) {
    throw new Error(`Archive chunk ${chunk.id} changed while it was being re-encoded`);
  }
}
