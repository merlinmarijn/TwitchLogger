ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS deleted_at bigint,
  ADD COLUMN IF NOT EXISTS hidden_image_urls jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS chat_messages_visible_timestamp_idx
  ON chat_messages (timestamp DESC)
  WHERE deleted_at IS NULL;
