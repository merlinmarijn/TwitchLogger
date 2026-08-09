-- Move values that repeat on nearly every message into compact dimensions.
-- Profile rows are immutable versions, so historical names and colours remain
-- exactly as they appeared when each message was received.
CREATE TABLE IF NOT EXISTS chat_senders (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  external_user_id text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS chat_sender_profiles (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sender_id bigint NOT NULL REFERENCES chat_senders(id),
  username text NOT NULL,
  display_name text NOT NULL,
  user_color text,
  CONSTRAINT chat_sender_profiles_identity_key
    UNIQUE NULLS NOT DISTINCT (sender_id, username, display_name, user_color)
);

CREATE TABLE IF NOT EXISTS chat_channel_profiles (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id text NOT NULL REFERENCES channels(id),
  external_channel_id text NOT NULL,
  username text NOT NULL,
  CONSTRAINT chat_channel_profiles_identity_key
    UNIQUE (channel_id, external_channel_id, username)
);

CREATE TABLE IF NOT EXISTS chat_badge_sets (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  badges jsonb NOT NULL UNIQUE,
  CHECK (jsonb_typeof(badges) = 'array')
);

CREATE TABLE IF NOT EXISTS chat_message_types (
  id smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL UNIQUE
);

INSERT INTO chat_senders (external_user_id)
SELECT DISTINCT sender_id FROM chat_messages
ON CONFLICT (external_user_id) DO NOTHING;

INSERT INTO chat_sender_profiles (
  sender_id, username, display_name, user_color
)
SELECT sender.id, message.sender_username, message.sender_display_name,
       message.user_color
FROM chat_messages AS message
JOIN chat_senders AS sender ON sender.external_user_id = message.sender_id
GROUP BY sender.id, message.sender_username, message.sender_display_name,
         message.user_color
ON CONFLICT ON CONSTRAINT chat_sender_profiles_identity_key DO NOTHING;

INSERT INTO chat_channel_profiles (
  channel_id, external_channel_id, username
)
SELECT channel_id, external_channel_id, channel_name
FROM chat_messages
GROUP BY channel_id, external_channel_id, channel_name
ON CONFLICT ON CONSTRAINT chat_channel_profiles_identity_key DO NOTHING;

INSERT INTO chat_badge_sets (badges)
SELECT DISTINCT badges FROM chat_messages
ON CONFLICT (badges) DO NOTHING;

INSERT INTO chat_message_types (name)
SELECT DISTINCT message_type FROM chat_messages
ON CONFLICT (name) DO NOTHING;

ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS sender_profile_id bigint,
  ADD COLUMN IF NOT EXISTS channel_profile_id bigint,
  ADD COLUMN IF NOT EXISTS badge_set_id bigint,
  ADD COLUMN IF NOT EXISTS message_type_id smallint,
  ADD COLUMN IF NOT EXISTS role_flags smallint,
  ADD COLUMN IF NOT EXISTS native_emotes jsonb;

UPDATE chat_messages AS message
SET sender_profile_id = profile.id,
    channel_profile_id = channel_profile.id,
    badge_set_id = badge_set.id,
    message_type_id = message_type.id,
    role_flags =
      (CASE WHEN message.is_broadcaster THEN 1 ELSE 0 END) |
      (CASE WHEN message.is_moderator THEN 2 ELSE 0 END) |
      (CASE WHEN message.is_subscriber THEN 4 ELSE 0 END) |
      (CASE WHEN message.is_vip THEN 8 ELSE 0 END)
FROM chat_senders AS sender,
     chat_sender_profiles AS profile,
     chat_channel_profiles AS channel_profile,
     chat_badge_sets AS badge_set,
     chat_message_types AS message_type
WHERE sender.external_user_id = message.sender_id
  AND profile.sender_id = sender.id
  AND profile.username = message.sender_username
  AND profile.display_name = message.sender_display_name
  AND profile.user_color IS NOT DISTINCT FROM message.user_color
  AND channel_profile.channel_id = message.channel_id
  AND channel_profile.external_channel_id = message.external_channel_id
  AND channel_profile.username = message.channel_name
  AND badge_set.badges = message.badges
  AND message_type.name = message.message_type;

-- The UI only needs native Twitch emote locations. Plain fragments duplicate
-- message_text, while non-emote fragment kinds are already rendered as text.
WITH fragments AS (
  SELECT message.id,
         fragment.value,
         fragment.ordinality,
         COALESCE(
           sum(char_length(COALESCE(fragment.value->>'text', ''))) OVER (
             PARTITION BY message.id
             ORDER BY fragment.ordinality
             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
           ),
           0
         )::integer AS start_offset
  FROM chat_messages AS message
  CROSS JOIN LATERAL jsonb_array_elements(
    COALESCE(message.metadata->'fragments', '[]'::jsonb)
  ) WITH ORDINALITY AS fragment(value, ordinality)
), compact AS (
  SELECT id,
         jsonb_agg(
           jsonb_build_array(
             start_offset,
             char_length(COALESCE(value->>'text', '')),
             value #>> '{emote,id}',
             COALESCE((value #> '{emote,format}') ? 'animated', false)
           )
           ORDER BY ordinality
         ) AS native_emotes
  FROM fragments
  WHERE value->>'type' = 'emote'
    AND value #>> '{emote,id}' IS NOT NULL
  GROUP BY id
)
UPDATE chat_messages AS message
SET native_emotes = compact.native_emotes
FROM compact
WHERE message.id = compact.id;

ALTER TABLE chat_messages
  ALTER COLUMN hidden_image_urls DROP NOT NULL,
  ALTER COLUMN hidden_image_urls DROP DEFAULT;

UPDATE chat_messages SET image_urls = NULL WHERE image_urls = '[]'::jsonb;
UPDATE chat_messages SET hidden_image_urls = NULL WHERE hidden_image_urls = '[]'::jsonb;

ALTER TABLE chat_messages
  ALTER COLUMN sender_profile_id SET NOT NULL,
  ALTER COLUMN channel_profile_id SET NOT NULL,
  ALTER COLUMN badge_set_id SET NOT NULL,
  ALTER COLUMN message_type_id SET NOT NULL,
  ALTER COLUMN role_flags SET NOT NULL,
  ADD CONSTRAINT chat_messages_sender_profile_fk
    FOREIGN KEY (sender_profile_id) REFERENCES chat_sender_profiles(id),
  ADD CONSTRAINT chat_messages_channel_profile_fk
    FOREIGN KEY (channel_profile_id) REFERENCES chat_channel_profiles(id),
  ADD CONSTRAINT chat_messages_badge_set_fk
    FOREIGN KEY (badge_set_id) REFERENCES chat_badge_sets(id),
  ADD CONSTRAINT chat_messages_message_type_fk
    FOREIGN KEY (message_type_id) REFERENCES chat_message_types(id),
  ADD CONSTRAINT chat_messages_role_flags_check
    CHECK (role_flags BETWEEN 0 AND 15);

DROP INDEX IF EXISTS chat_messages_search_trigram_idx;
DROP INDEX IF EXISTS chat_messages_visible_sender_username_trigram_idx;
DROP INDEX IF EXISTS chat_messages_visible_sender_display_name_trigram_idx;
DROP INDEX IF EXISTS chat_messages_image_version_idx;

ALTER TABLE chat_messages
  DROP COLUMN platform,
  DROP COLUMN event_notification_id,
  DROP COLUMN external_channel_id,
  DROP COLUMN channel_name,
  DROP COLUMN sender_id,
  DROP COLUMN sender_username,
  DROP COLUMN sender_display_name,
  DROP COLUMN gallery_channel_id,
  DROP COLUMN badges,
  DROP COLUMN user_color,
  DROP COLUMN is_broadcaster,
  DROP COLUMN is_moderator,
  DROP COLUMN is_subscriber,
  DROP COLUMN is_vip,
  DROP COLUMN message_type,
  DROP COLUMN metadata,
  DROP COLUMN raw_message_data,
  DROP COLUMN created_at;

-- Run the narrowing rewrite after the drops so PostgreSQL physically removes
-- the old column payloads instead of only hiding them from the catalog.
ALTER TABLE chat_messages
  ALTER COLUMN image_index_version TYPE smallint
  USING image_index_version::smallint;

CREATE INDEX IF NOT EXISTS chat_messages_search_trigram_idx
  ON chat_messages USING gin (lower(message_text) gin_trgm_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS chat_messages_sender_profile_timestamp_idx
  ON chat_messages (sender_profile_id, timestamp DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS chat_sender_profiles_username_trigram_idx
  ON chat_sender_profiles USING gin (lower(username) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS chat_sender_profiles_display_name_trigram_idx
  ON chat_sender_profiles USING gin (lower(display_name) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS chat_channel_profiles_channel_idx
  ON chat_channel_profiles (channel_id);

CREATE OR REPLACE VIEW chat_messages_expanded AS
SELECT message.id,
       message.channel_id,
       channel.platform,
       message.external_message_id,
       channel_profile.external_channel_id,
       channel_profile.username AS channel_name,
       sender.external_user_id AS sender_id,
       sender_profile.username AS sender_username,
       sender_profile.display_name AS sender_display_name,
       message.message_text,
       message.has_images,
       message.image_urls,
       message.image_index_version,
       message.timestamp,
       badge_set.badges,
       sender_profile.user_color,
       (message.role_flags & 1) <> 0 AS is_broadcaster,
       (message.role_flags & 2) <> 0 AS is_moderator,
       (message.role_flags & 4) <> 0 AS is_subscriber,
       (message.role_flags & 8) <> 0 AS is_vip,
       message_type.name AS message_type,
       message.native_emotes,
       message.hidden_image_urls,
       message.deleted_at,
       message.sender_profile_id,
       message.channel_profile_id,
       message.badge_set_id,
       message.message_type_id,
       message.role_flags
FROM chat_messages AS message
JOIN channels AS channel ON channel.id = message.channel_id
JOIN chat_channel_profiles AS channel_profile
  ON channel_profile.id = message.channel_profile_id
JOIN chat_sender_profiles AS sender_profile
  ON sender_profile.id = message.sender_profile_id
JOIN chat_senders AS sender ON sender.id = sender_profile.sender_id
JOIN chat_badge_sets AS badge_set ON badge_set.id = message.badge_set_id
JOIN chat_message_types AS message_type ON message_type.id = message.message_type_id;

-- New cold catalog rows use the compact sender profile reference. Legacy cold
-- rows keep their strings until their existing v1 chunks are naturally read.
ALTER TABLE chat_message_cold_catalog
  ADD COLUMN IF NOT EXISTS sender_profile_id bigint
    REFERENCES chat_sender_profiles(id);

DROP INDEX IF EXISTS chat_message_cold_sender_username_trigram_idx;
DROP INDEX IF EXISTS chat_message_cold_sender_display_name_trigram_idx;

CREATE INDEX IF NOT EXISTS chat_message_cold_sender_profile_idx
  ON chat_message_cold_catalog (sender_profile_id, timestamp DESC)
  WHERE deleted_at IS NULL AND sender_profile_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS chat_message_cold_legacy_sender_username_trigram_idx
  ON chat_message_cold_catalog USING gin (lower(sender_username) gin_trgm_ops)
  WHERE deleted_at IS NULL AND sender_profile_id IS NULL;

CREATE INDEX IF NOT EXISTS chat_message_cold_legacy_sender_display_name_trigram_idx
  ON chat_message_cold_catalog USING gin (lower(sender_display_name) gin_trgm_ops)
  WHERE deleted_at IS NULL AND sender_profile_id IS NULL;

ALTER TABLE chat_message_cold_chunks
  DROP CONSTRAINT IF EXISTS chat_message_cold_chunks_codec_check;

ALTER TABLE chat_message_cold_chunks
  ADD CONSTRAINT chat_message_cold_chunks_codec_check
  CHECK (codec IN ('brotli-canonical-v1', 'brotli-canonical-v2'));

DELETE FROM archive_settings WHERE key = 'raw_source_cleanup';
