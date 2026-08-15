-- Compact the hot message relation and the relational cold metadata. Public
-- channel IDs and internal legacy message IDs intentionally remain strings.
-- Acquire every relation before inspecting or rewriting data. In a rolling
-- deploy, the previous worker can otherwise hold chat_messages and request
-- channels while this migration holds channels and requests chat_messages.
-- The view lock also prevents a new page query from holding the view while it
-- waits on one of the already locked base tables.
LOCK TABLE
  chat_messages_expanded,
  chat_message_cold_chunks,
  chat_message_cold_catalog,
  chat_message_cold_chunk_keys,
  chat_message_cold_sender_stats,
  chat_messages,
  chat_raw_events,
  channels,
  chat_senders,
  chat_sender_profiles,
  chat_channel_profiles,
  chat_badge_sets
IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM chat_messages WHERE external_message_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') OR
     EXISTS (SELECT 1 FROM chat_raw_events WHERE external_message_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') OR
     EXISTS (SELECT 1 FROM chat_message_cold_catalog WHERE external_message_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') THEN
    RAISE EXCEPTION 'External message IDs must all be UUIDs before migration 024';
  END IF;
  IF (SELECT COALESCE(max(id), 0) FROM chat_senders) > 2147483647 OR
     (SELECT COALESCE(max(id), 0) FROM chat_sender_profiles) > 2147483647 OR
     (SELECT COALESCE(max(id), 0) FROM chat_channel_profiles) > 2147483647 OR
     (SELECT COALESCE(max(id), 0) FROM chat_badge_sets) > 2147483647 THEN
    RAISE EXCEPTION 'A message dimension exceeds the integer key range';
  END IF;
END $$;

ALTER TABLE channels
  ADD COLUMN storage_key integer GENERATED ALWAYS AS IDENTITY;
ALTER TABLE channels ADD CONSTRAINT channels_storage_key_key UNIQUE (storage_key);

DROP VIEW chat_messages_expanded;

ALTER TABLE chat_messages ADD COLUMN channel_key integer;
UPDATE chat_messages AS message
SET channel_key = channel.storage_key
FROM channels AS channel
WHERE channel.id = message.channel_id;
ALTER TABLE chat_messages ALTER COLUMN channel_key SET NOT NULL;

ALTER TABLE chat_message_cold_chunks ADD COLUMN channel_key integer;
UPDATE chat_message_cold_chunks AS chunk
SET channel_key = channel.storage_key
FROM channels AS channel
WHERE channel.id = chunk.channel_id;
ALTER TABLE chat_message_cold_chunks ALTER COLUMN channel_key SET NOT NULL;

ALTER TABLE chat_message_cold_catalog ADD COLUMN channel_key integer;
UPDATE chat_message_cold_catalog AS catalog
SET channel_key = channel.storage_key
FROM channels AS channel
WHERE channel.id = catalog.channel_id;
ALTER TABLE chat_message_cold_catalog ALTER COLUMN channel_key SET NOT NULL;

DROP INDEX chat_messages_visible_channel_images_timestamp_id_idx;
DROP INDEX chat_messages_visible_channel_timestamp_id_idx;
DROP INDEX chat_message_cold_compact_channel_page_idx;
DROP INDEX chat_message_cold_visible_channel_images_timestamp_idx;
DROP INDEX chat_message_cold_visible_channel_timestamp_idx;

ALTER TABLE chat_messages
  DROP CONSTRAINT chat_messages_channel_id_fkey,
  DROP CONSTRAINT chat_messages_sender_profile_fk,
  DROP CONSTRAINT chat_messages_channel_profile_fk,
  DROP CONSTRAINT chat_messages_badge_set_fk;
ALTER TABLE chat_sender_profiles DROP CONSTRAINT chat_sender_profiles_sender_id_fkey;
ALTER TABLE chat_message_cold_catalog
  DROP CONSTRAINT chat_message_cold_catalog_channel_id_fkey,
  DROP CONSTRAINT chat_message_cold_catalog_chunk_id_fkey,
  DROP CONSTRAINT chat_message_cold_catalog_sender_profile_id_fkey;
ALTER TABLE chat_message_cold_chunks DROP CONSTRAINT chat_message_cold_chunks_channel_id_fkey;
ALTER TABLE chat_message_cold_chunk_keys DROP CONSTRAINT chat_message_cold_chunk_keys_chunk_id_fkey;
ALTER TABLE chat_message_cold_sender_stats
  DROP CONSTRAINT chat_message_cold_sender_stats_chunk_id_fkey,
  DROP CONSTRAINT chat_message_cold_sender_stats_sender_profile_id_fkey;

ALTER TABLE chat_messages
  ALTER COLUMN external_message_id TYPE uuid USING external_message_id::uuid,
  ALTER COLUMN sender_profile_id TYPE integer,
  ALTER COLUMN channel_profile_id TYPE integer,
  ALTER COLUMN badge_set_id TYPE integer;
ALTER TABLE chat_raw_events
  ALTER COLUMN external_message_id TYPE uuid USING external_message_id::uuid;
ALTER TABLE chat_senders ALTER COLUMN id TYPE integer;
ALTER TABLE chat_sender_profiles
  ALTER COLUMN id TYPE integer,
  ALTER COLUMN sender_id TYPE integer;
ALTER TABLE chat_channel_profiles ALTER COLUMN id TYPE integer;
ALTER TABLE chat_badge_sets ALTER COLUMN id TYPE integer;
ALTER TABLE chat_message_cold_catalog
  ALTER COLUMN external_message_id TYPE uuid USING external_message_id::uuid,
  ALTER COLUMN chunk_id TYPE uuid USING chunk_id::uuid,
  ALTER COLUMN sender_profile_id TYPE integer;
ALTER TABLE chat_message_cold_chunk_keys ALTER COLUMN chunk_id TYPE uuid USING chunk_id::uuid;
ALTER TABLE chat_message_cold_sender_stats
  ALTER COLUMN chunk_id TYPE uuid USING chunk_id::uuid,
  ALTER COLUMN sender_profile_id TYPE integer;
ALTER TABLE chat_message_cold_chunks ALTER COLUMN id TYPE uuid USING id::uuid;

ALTER SEQUENCE chat_senders_id_seq AS integer NO MAXVALUE;
ALTER SEQUENCE chat_sender_profiles_id_seq AS integer NO MAXVALUE;
ALTER SEQUENCE chat_channel_profiles_id_seq AS integer NO MAXVALUE;
ALTER SEQUENCE chat_badge_sets_id_seq AS integer NO MAXVALUE;

ALTER TABLE chat_sender_profiles ADD CONSTRAINT chat_sender_profiles_sender_id_fkey
  FOREIGN KEY (sender_id) REFERENCES chat_senders(id);
ALTER TABLE chat_messages
  ADD CONSTRAINT chat_messages_channel_key_fkey FOREIGN KEY (channel_key) REFERENCES channels(storage_key),
  ADD CONSTRAINT chat_messages_sender_profile_fk FOREIGN KEY (sender_profile_id) REFERENCES chat_sender_profiles(id),
  ADD CONSTRAINT chat_messages_channel_profile_fk FOREIGN KEY (channel_profile_id) REFERENCES chat_channel_profiles(id),
  ADD CONSTRAINT chat_messages_badge_set_fk FOREIGN KEY (badge_set_id) REFERENCES chat_badge_sets(id);
ALTER TABLE chat_message_cold_chunks
  ADD CONSTRAINT chat_message_cold_chunks_channel_key_fkey FOREIGN KEY (channel_key) REFERENCES channels(storage_key);
ALTER TABLE chat_message_cold_catalog
  ADD CONSTRAINT chat_message_cold_catalog_channel_key_fkey FOREIGN KEY (channel_key) REFERENCES channels(storage_key),
  ADD CONSTRAINT chat_message_cold_catalog_chunk_id_fkey FOREIGN KEY (chunk_id) REFERENCES chat_message_cold_chunks(id) ON DELETE CASCADE,
  ADD CONSTRAINT chat_message_cold_catalog_sender_profile_id_fkey FOREIGN KEY (sender_profile_id) REFERENCES chat_sender_profiles(id);
ALTER TABLE chat_message_cold_chunk_keys ADD CONSTRAINT chat_message_cold_chunk_keys_chunk_id_fkey
  FOREIGN KEY (chunk_id) REFERENCES chat_message_cold_chunks(id) ON DELETE CASCADE;
ALTER TABLE chat_message_cold_sender_stats
  ADD CONSTRAINT chat_message_cold_sender_stats_chunk_id_fkey FOREIGN KEY (chunk_id) REFERENCES chat_message_cold_chunks(id) ON DELETE CASCADE,
  ADD CONSTRAINT chat_message_cold_sender_stats_sender_profile_id_fkey FOREIGN KEY (sender_profile_id) REFERENCES chat_sender_profiles(id);

ALTER TABLE chat_messages DROP COLUMN channel_id;
ALTER TABLE chat_message_cold_chunks DROP COLUMN channel_id;
ALTER TABLE chat_message_cold_catalog DROP COLUMN channel_id;

CREATE INDEX chat_messages_visible_channel_timestamp_id_idx
  ON chat_messages (channel_key, timestamp DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX chat_messages_visible_channel_images_timestamp_id_idx
  ON chat_messages (channel_key, timestamp DESC, id DESC)
  WHERE deleted_at IS NULL AND has_images = true;
CREATE INDEX chat_message_cold_compact_channel_page_idx
  ON chat_message_cold_chunks (channel_key, last_timestamp DESC, first_timestamp DESC, id DESC)
  WHERE compact_indexed = true AND active_message_count > 0;
CREATE INDEX chat_message_cold_visible_channel_timestamp_idx
  ON chat_message_cold_catalog (channel_key, timestamp DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX chat_message_cold_visible_channel_images_timestamp_idx
  ON chat_message_cold_catalog (channel_key, timestamp DESC, id DESC)
  WHERE deleted_at IS NULL AND has_images = true;

ALTER TABLE chat_message_cold_chunks DROP CONSTRAINT chat_message_cold_chunks_codec_check;
ALTER TABLE chat_message_cold_chunks ADD CONSTRAINT chat_message_cold_chunks_codec_check
  CHECK (codec IN ('brotli-canonical-v1', 'brotli-canonical-v2', 'brotli-positional-v3'));
ALTER TABLE chat_message_cold_chunks
  ADD COLUMN image_projection_indexed boolean NOT NULL DEFAULT false;

-- V3 chunks use the canonical compact table. The previous shape remains only
-- as an explicitly named compatibility bridge until v1/v2 chunks are gone.
ALTER TABLE chat_message_cold_sender_stats RENAME TO chat_message_cold_sender_stats_legacy;
ALTER TABLE chat_message_cold_sender_stats_legacy
  RENAME CONSTRAINT chat_message_cold_sender_stats_pkey TO chat_message_cold_sender_stats_legacy_pkey;
ALTER INDEX chat_message_cold_sender_stats_profile_idx
  RENAME TO chat_message_cold_sender_stats_legacy_profile_idx;
CREATE TABLE chat_message_cold_sender_stats (
  chunk_id uuid NOT NULL REFERENCES chat_message_cold_chunks(id) ON DELETE CASCADE,
  sender_profile_id integer NOT NULL REFERENCES chat_sender_profiles(id),
  message_count integer NOT NULL CHECK (message_count > 0),
  last_timestamp bigint NOT NULL,
  PRIMARY KEY (chunk_id, sender_profile_id)
);
CREATE INDEX chat_message_cold_sender_stats_profile_idx
  ON chat_message_cold_sender_stats (sender_profile_id, last_timestamp DESC);

CREATE TABLE chat_message_cold_images (
  id text PRIMARY KEY,
  chunk_id uuid NOT NULL REFERENCES chat_message_cold_chunks(id) ON DELETE CASCADE,
  channel_key integer NOT NULL REFERENCES channels(storage_key),
  timestamp bigint NOT NULL,
  record jsonb NOT NULL
);
CREATE INDEX chat_message_cold_images_page_idx
  ON chat_message_cold_images (timestamp DESC, id DESC);
CREATE INDEX chat_message_cold_images_channel_page_idx
  ON chat_message_cold_images (channel_key, timestamp DESC, id DESC);

CREATE OR REPLACE FUNCTION find_cold_message_chunk(target uuid)
RETURNS TABLE(chunk_id uuid) LANGUAGE sql STABLE SET enable_seqscan = off AS $$
  SELECT keys.chunk_id FROM chat_message_cold_chunk_keys AS keys
  WHERE keys.external_message_ids @> ARRAY[target] LIMIT 1
$$;
CREATE OR REPLACE FUNCTION find_cold_message_chunks(targets uuid[])
RETURNS TABLE(chunk_id uuid) LANGUAGE sql STABLE SET enable_seqscan = off AS $$
  SELECT keys.chunk_id FROM chat_message_cold_chunk_keys AS keys
  WHERE keys.external_message_ids && targets
$$;

CREATE VIEW chat_messages_expanded AS
SELECT message.id,
       channel.id AS channel_id,
       channel.platform,
       message.external_message_id,
       channel_profile.external_channel_id,
       channel_profile.username AS channel_name,
       sender.external_user_id AS sender_id,
       sender_profile.username AS sender_username,
       sender_profile.display_name AS sender_display_name,
       message.message_text, message.has_images, message.image_urls,
       message.image_index_version, message.timestamp, badge_set.badges,
       sender_profile.user_color,
       (message.role_flags & 1) <> 0 AS is_broadcaster,
       (message.role_flags & 2) <> 0 AS is_moderator,
       (message.role_flags & 4) <> 0 AS is_subscriber,
       (message.role_flags & 8) <> 0 AS is_vip,
       message_type.name AS message_type, message.native_emotes,
       message.hidden_image_urls, message.deleted_at,
       message.sender_profile_id, message.channel_profile_id,
       message.badge_set_id, message.message_type_id, message.role_flags
FROM chat_messages AS message
JOIN channels AS channel ON channel.storage_key = message.channel_key
JOIN chat_channel_profiles AS channel_profile ON channel_profile.id = message.channel_profile_id
JOIN chat_sender_profiles AS sender_profile ON sender_profile.id = message.sender_profile_id
JOIN chat_senders AS sender ON sender.id = sender_profile.sender_id
JOIN chat_badge_sets AS badge_set ON badge_set.id = message.badge_set_id
JOIN chat_message_types AS message_type ON message_type.id = message.message_type_id;
