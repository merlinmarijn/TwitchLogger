-- These legacy indexes are superseded by the partial keyset indexes added in
-- 003_message_search_performance.sql or do not support any live query.
DROP INDEX IF EXISTS chat_messages_event_notification_idx;
DROP INDEX IF EXISTS chat_messages_platform_timestamp_idx;
DROP INDEX IF EXISTS chat_messages_sender_timestamp_idx;
DROP INDEX IF EXISTS chat_messages_gallery_channel_timestamp_idx;
DROP INDEX IF EXISTS chat_messages_channel_timestamp_idx;
DROP INDEX IF EXISTS chat_messages_timestamp_idx;
DROP INDEX IF EXISTS chat_messages_visible_timestamp_idx;
DROP INDEX IF EXISTS chat_messages_images_timestamp_idx;

-- Saved views are evaluated directly against chat_messages. This table is
-- derived legacy state, has no write path, and is already discarded by the
-- old "view refresh" maintenance operation.
DROP TABLE IF EXISTS chat_tab_matches;
