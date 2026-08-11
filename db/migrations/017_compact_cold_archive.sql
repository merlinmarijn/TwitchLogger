-- Replace the per-message cold catalog with one compact key array per chunk
-- plus aggregated sender statistics. Existing chunks remain on the legacy
-- catalog until the worker verifies and converts each chunk transactionally.
ALTER TABLE chat_message_cold_chunks
  ADD COLUMN IF NOT EXISTS compact_indexed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS active_message_count integer,
  ADD COLUMN IF NOT EXISTS image_message_count integer;

ALTER TABLE chat_message_cold_chunks
  ADD CONSTRAINT chat_message_cold_chunks_active_count_check
    CHECK (active_message_count IS NULL OR
      active_message_count BETWEEN 0 AND message_count),
  ADD CONSTRAINT chat_message_cold_chunks_image_count_check
    CHECK (image_message_count IS NULL OR
      image_message_count BETWEEN 0 AND COALESCE(active_message_count, message_count));

CREATE INDEX IF NOT EXISTS chat_message_cold_compact_page_idx
  ON chat_message_cold_chunks (last_timestamp DESC, first_timestamp DESC, id DESC)
  WHERE compact_indexed = true AND active_message_count > 0;

CREATE INDEX IF NOT EXISTS chat_message_cold_compact_channel_page_idx
  ON chat_message_cold_chunks (
    channel_id, last_timestamp DESC, first_timestamp DESC, id DESC
  )
  WHERE compact_indexed = true AND active_message_count > 0;

CREATE TABLE IF NOT EXISTS chat_message_cold_chunk_keys (
  chunk_id text PRIMARY KEY
    REFERENCES chat_message_cold_chunks(id) ON DELETE CASCADE,
  external_message_ids uuid[] NOT NULL,
  CHECK (cardinality(external_message_ids) > 0)
);

CREATE INDEX IF NOT EXISTS chat_message_cold_chunk_external_ids_idx
  ON chat_message_cold_chunk_keys USING gin (external_message_ids);

CREATE TABLE IF NOT EXISTS chat_message_cold_sender_stats (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chunk_id text NOT NULL
    REFERENCES chat_message_cold_chunks(id) ON DELETE CASCADE,
  sender_profile_id bigint REFERENCES chat_sender_profiles(id),
  sender_username text,
  sender_display_name text,
  message_count integer NOT NULL CHECK (message_count > 0),
  last_timestamp bigint NOT NULL,
  CHECK (
    sender_profile_id IS NOT NULL OR
    (sender_username IS NOT NULL AND sender_display_name IS NOT NULL)
  ),
  CONSTRAINT chat_message_cold_sender_stats_identity_key
    UNIQUE NULLS NOT DISTINCT (
      chunk_id, sender_profile_id, sender_username, sender_display_name
    )
);

CREATE INDEX IF NOT EXISTS chat_message_cold_sender_stats_profile_idx
  ON chat_message_cold_sender_stats (sender_profile_id, last_timestamp DESC)
  WHERE sender_profile_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS chat_message_cold_sender_stats_legacy_username_idx
  ON chat_message_cold_sender_stats USING gin (lower(sender_username) gin_trgm_ops)
  WHERE sender_profile_id IS NULL;

CREATE INDEX IF NOT EXISTS chat_message_cold_sender_stats_legacy_display_name_idx
  ON chat_message_cold_sender_stats USING gin (lower(sender_display_name) gin_trgm_ops)
  WHERE sender_profile_id IS NULL;
