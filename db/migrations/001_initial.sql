CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platforms (
  id text PRIMARY KEY,
  convex_creation_time double precision,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  enabled boolean NOT NULL,
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  id text PRIMARY KEY,
  convex_creation_time double precision,
  platform text NOT NULL,
  external_channel_id text,
  username text NOT NULL,
  display_name text NOT NULL,
  logging_enabled boolean NOT NULL,
  connection_status text NOT NULL CHECK (connection_status IN (
    'disconnected', 'connecting', 'connected', 'error', 'authorization_required'
  )),
  connection_error text,
  hidden_at bigint,
  last_connected_at bigint,
  last_message_at bigint,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  UNIQUE (platform, username)
);
CREATE INDEX IF NOT EXISTS channels_logging_idx ON channels (logging_enabled);
CREATE INDEX IF NOT EXISTS channels_last_message_idx ON channels (last_message_at);
CREATE INDEX IF NOT EXISTS channels_external_id_idx ON channels (external_channel_id);

CREATE TABLE IF NOT EXISTS chat_tabs (
  id text PRIMARY KEY,
  convex_creation_time double precision,
  client_id text NOT NULL UNIQUE,
  name text NOT NULL,
  layout text NOT NULL CHECK (layout IN ('chat', 'gallery')),
  match text NOT NULL CHECK (match IN ('all', 'any')),
  rules jsonb NOT NULL,
  revision bigint NOT NULL,
  indexed_revision bigint,
  index_status text NOT NULL CHECK (index_status IN ('building', 'ready')),
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id text PRIMARY KEY,
  convex_creation_time double precision,
  channel_id text NOT NULL REFERENCES channels(id),
  platform text NOT NULL,
  external_message_id text NOT NULL UNIQUE,
  event_notification_id text NOT NULL,
  external_channel_id text NOT NULL,
  channel_name text NOT NULL,
  sender_id text NOT NULL,
  sender_username text NOT NULL,
  sender_display_name text NOT NULL,
  message_text text NOT NULL,
  has_images boolean,
  image_urls jsonb,
  image_index_version bigint,
  gallery_channel_id text REFERENCES channels(id),
  timestamp bigint NOT NULL,
  badges jsonb NOT NULL,
  user_color text,
  is_broadcaster boolean NOT NULL,
  is_moderator boolean NOT NULL,
  is_subscriber boolean NOT NULL,
  is_vip boolean NOT NULL,
  message_type text NOT NULL,
  metadata jsonb NOT NULL,
  raw_message_data jsonb NOT NULL,
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_messages_channel_timestamp_idx ON chat_messages (channel_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS chat_messages_platform_timestamp_idx ON chat_messages (platform, timestamp DESC);
CREATE INDEX IF NOT EXISTS chat_messages_sender_timestamp_idx ON chat_messages (sender_username, timestamp DESC);
CREATE INDEX IF NOT EXISTS chat_messages_timestamp_idx ON chat_messages (timestamp DESC);
CREATE INDEX IF NOT EXISTS chat_messages_images_timestamp_idx ON chat_messages (has_images, timestamp DESC);
CREATE INDEX IF NOT EXISTS chat_messages_image_version_idx ON chat_messages (image_index_version);
CREATE INDEX IF NOT EXISTS chat_messages_gallery_channel_timestamp_idx ON chat_messages (gallery_channel_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS chat_messages_event_notification_idx ON chat_messages (event_notification_id);
CREATE INDEX IF NOT EXISTS chat_messages_search_idx ON chat_messages USING gin (
  to_tsvector('simple', message_text || ' ' || sender_username || ' ' || sender_display_name || ' ' || channel_name)
);

CREATE TABLE IF NOT EXISTS chat_tab_matches (
  id text PRIMARY KEY,
  convex_creation_time double precision,
  tab_id text NOT NULL REFERENCES chat_tabs(id) ON DELETE CASCADE,
  revision bigint NOT NULL,
  message_id text NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  channel_id text NOT NULL REFERENCES channels(id),
  timestamp bigint NOT NULL,
  has_images boolean NOT NULL,
  UNIQUE (tab_id, revision, message_id)
);
CREATE INDEX IF NOT EXISTS chat_tab_matches_tab_timestamp_idx ON chat_tab_matches (tab_id, revision, timestamp DESC);
CREATE INDEX IF NOT EXISTS chat_tab_matches_tab_channel_timestamp_idx ON chat_tab_matches (tab_id, revision, channel_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS chat_tab_matches_tab_images_timestamp_idx ON chat_tab_matches (tab_id, revision, has_images, timestamp DESC);

CREATE TABLE IF NOT EXISTS admin_settings (
  id text PRIMARY KEY,
  convex_creation_time double precision,
  key text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  password_salt text NOT NULL,
  password_cost bigint NOT NULL,
  totp_secret_encrypted text,
  totp_enabled boolean NOT NULL,
  auth_revision bigint NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_jobs (
  id text PRIMARY KEY,
  convex_creation_time double precision,
  kind text NOT NULL,
  status text NOT NULL,
  title text NOT NULL,
  detail text NOT NULL,
  current bigint NOT NULL,
  total bigint,
  unit text NOT NULL,
  cursor text,
  metadata jsonb,
  error text,
  requested_by text NOT NULL,
  created_at bigint NOT NULL,
  started_at bigint,
  updated_at bigint NOT NULL,
  finished_at bigint
);
CREATE INDEX IF NOT EXISTS admin_jobs_status_idx ON admin_jobs (status);
CREATE INDEX IF NOT EXISTS admin_jobs_created_at_idx ON admin_jobs (created_at DESC);

CREATE TABLE IF NOT EXISTS admin_metrics (
  id text PRIMARY KEY,
  convex_creation_time double precision,
  key text NOT NULL UNIQUE,
  function_calls bigint NOT NULL,
  error_count bigint NOT NULL,
  total_execution_ms double precision NOT NULL,
  cache_hits bigint NOT NULL,
  cache_misses bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_database_stats (
  id text PRIMARY KEY,
  convex_creation_time double precision,
  key text NOT NULL UNIQUE,
  generated_at bigint NOT NULL,
  document_count bigint NOT NULL,
  document_bytes bigint NOT NULL,
  tables jsonb NOT NULL,
  scope text NOT NULL
);

CREATE TABLE IF NOT EXISTS maintenance_throttle (
  id text PRIMARY KEY,
  convex_creation_time double precision,
  key text NOT NULL UNIQUE,
  next_batch_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id text PRIMARY KEY,
  convex_creation_time double precision,
  event text NOT NULL,
  detail text NOT NULL,
  actor text NOT NULL,
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_audit_log_created_at_idx ON admin_audit_log (created_at DESC);
