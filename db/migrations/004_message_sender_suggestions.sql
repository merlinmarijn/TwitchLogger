CREATE INDEX IF NOT EXISTS chat_messages_visible_sender_username_trigram_idx
  ON chat_messages USING gin (lower(sender_username) gin_trgm_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS chat_messages_visible_sender_display_name_trigram_idx
  ON chat_messages USING gin (lower(sender_display_name) gin_trgm_ops)
  WHERE deleted_at IS NULL;
