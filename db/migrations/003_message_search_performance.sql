CREATE EXTENSION IF NOT EXISTS pg_trgm;

DROP INDEX IF EXISTS chat_messages_search_idx;

CREATE INDEX IF NOT EXISTS chat_messages_search_trigram_idx
  ON chat_messages USING gin (
    (lower(message_text || ' ' || sender_username || ' ' || sender_display_name || ' ' || channel_name))
    gin_trgm_ops
  )
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS chat_messages_visible_timestamp_id_idx
  ON chat_messages (timestamp DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS chat_messages_visible_channel_timestamp_id_idx
  ON chat_messages (channel_id, timestamp DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS chat_messages_visible_images_timestamp_id_idx
  ON chat_messages (timestamp DESC, id DESC)
  WHERE deleted_at IS NULL AND has_images = true;

CREATE INDEX IF NOT EXISTS chat_messages_visible_channel_images_timestamp_id_idx
  ON chat_messages (channel_id, timestamp DESC, id DESC)
  WHERE deleted_at IS NULL AND has_images = true;
