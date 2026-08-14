DROP VIEW IF EXISTS chat_messages_expanded;

ALTER TABLE chat_messages
  DROP CONSTRAINT IF EXISTS chat_messages_message_type_fk;

ALTER TABLE chat_message_types
  ALTER COLUMN id TYPE integer;

ALTER TABLE chat_messages
  ALTER COLUMN message_type_id TYPE integer;

ALTER SEQUENCE chat_message_types_id_seq
  AS integer
  NO MAXVALUE;

ALTER TABLE chat_messages
  ADD CONSTRAINT chat_messages_message_type_fk
  FOREIGN KEY (message_type_id) REFERENCES chat_message_types(id);

CREATE VIEW chat_messages_expanded AS
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
