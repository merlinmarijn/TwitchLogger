ALTER TABLE chat_message_cold_catalog
  ADD COLUMN IF NOT EXISTS sender_username text,
  ADD COLUMN IF NOT EXISTS sender_display_name text;

CREATE INDEX IF NOT EXISTS chat_message_cold_sender_username_trigram_idx
  ON chat_message_cold_catalog USING gin (lower(sender_username) gin_trgm_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS chat_message_cold_sender_display_name_trigram_idx
  ON chat_message_cold_catalog USING gin (lower(sender_display_name) gin_trgm_ops)
  WHERE deleted_at IS NULL;
