ALTER TABLE chat_messages
  ALTER COLUMN raw_message_data DROP NOT NULL;

CREATE TABLE IF NOT EXISTS chat_raw_events (
  external_message_id text PRIMARY KEY,
  event_notification_id text NOT NULL,
  channel_id text NOT NULL REFERENCES channels(id),
  timestamp bigint NOT NULL,
  raw_message_data jsonb NOT NULL,
  created_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS chat_raw_events_timestamp_idx
  ON chat_raw_events (timestamp);

CREATE TABLE IF NOT EXISTS chat_raw_event_chunks (
  id text PRIMARY KEY,
  channel_id text NOT NULL REFERENCES channels(id),
  period_start bigint NOT NULL,
  period_end bigint NOT NULL,
  first_timestamp bigint NOT NULL,
  last_timestamp bigint NOT NULL,
  message_count bigint NOT NULL CHECK (message_count > 0),
  codec text NOT NULL CHECK (codec = 'brotli-v1'),
  uncompressed_bytes bigint NOT NULL CHECK (uncompressed_bytes > 0),
  compressed_bytes bigint NOT NULL CHECK (compressed_bytes > 0),
  sha256 text NOT NULL UNIQUE,
  payload bytea NOT NULL,
  source_cleared_at bigint,
  created_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS chat_raw_event_chunks_period_idx
  ON chat_raw_event_chunks (period_start DESC, period_end DESC);

CREATE TABLE IF NOT EXISTS archive_settings (
  key text PRIMARY KEY,
  enabled boolean NOT NULL,
  updated_at bigint NOT NULL
);

INSERT INTO archive_settings (key, enabled, updated_at)
VALUES ('raw_source_cleanup', false, (extract(epoch FROM clock_timestamp()) * 1000)::bigint)
ON CONFLICT (key) DO NOTHING;

-- This is deliberately additive: the source JSON remains in chat_messages until
-- the application has compressed and independently verified every chunk.
INSERT INTO chat_raw_events (
  external_message_id,
  event_notification_id,
  channel_id,
  timestamp,
  raw_message_data,
  created_at
)
SELECT
  external_message_id,
  event_notification_id,
  channel_id,
  timestamp,
  raw_message_data,
  created_at
FROM chat_messages
WHERE raw_message_data IS NOT NULL
ON CONFLICT (external_message_id) DO NOTHING;
