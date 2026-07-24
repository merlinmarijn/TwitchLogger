CREATE TABLE IF NOT EXISTS chat_message_cold_chunks (
  id text PRIMARY KEY,
  channel_id text NOT NULL REFERENCES channels(id),
  period_start bigint NOT NULL,
  period_end bigint NOT NULL,
  first_timestamp bigint NOT NULL,
  last_timestamp bigint NOT NULL,
  message_count bigint NOT NULL CHECK (message_count > 0),
  codec text NOT NULL CHECK (codec = 'brotli-canonical-v1'),
  uncompressed_bytes bigint NOT NULL CHECK (uncompressed_bytes > 0),
  compressed_bytes bigint NOT NULL CHECK (compressed_bytes > 0),
  sha256 text NOT NULL UNIQUE,
  payload bytea NOT NULL,
  created_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS chat_message_cold_chunks_period_idx
  ON chat_message_cold_chunks (period_start DESC, period_end DESC);

CREATE TABLE IF NOT EXISTS chat_message_cold_catalog (
  id text PRIMARY KEY,
  external_message_id text NOT NULL UNIQUE,
  chunk_id text NOT NULL REFERENCES chat_message_cold_chunks(id) ON DELETE CASCADE,
  channel_id text NOT NULL REFERENCES channels(id),
  timestamp bigint NOT NULL,
  has_images boolean NOT NULL,
  deleted_at bigint
);

CREATE INDEX IF NOT EXISTS chat_message_cold_visible_timestamp_idx
  ON chat_message_cold_catalog (timestamp DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS chat_message_cold_visible_channel_timestamp_idx
  ON chat_message_cold_catalog (channel_id, timestamp DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS chat_message_cold_visible_images_timestamp_idx
  ON chat_message_cold_catalog (timestamp DESC, id DESC)
  WHERE deleted_at IS NULL AND has_images = true;

CREATE INDEX IF NOT EXISTS chat_message_cold_visible_channel_images_timestamp_idx
  ON chat_message_cold_catalog (channel_id, timestamp DESC, id DESC)
  WHERE deleted_at IS NULL AND has_images = true;

INSERT INTO archive_settings (key, enabled, updated_at)
VALUES ('cold_message_archive', false, (extract(epoch FROM clock_timestamp()) * 1000)::bigint)
ON CONFLICT (key) DO NOTHING;
