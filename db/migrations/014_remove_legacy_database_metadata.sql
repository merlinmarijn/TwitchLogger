DROP TABLE IF EXISTS maintenance_throttle;

ALTER TABLE platforms DROP COLUMN IF EXISTS convex_creation_time;
ALTER TABLE channels DROP COLUMN IF EXISTS convex_creation_time;
ALTER TABLE chat_tabs DROP COLUMN IF EXISTS convex_creation_time;
ALTER TABLE chat_messages DROP COLUMN IF EXISTS convex_creation_time;
ALTER TABLE admin_settings DROP COLUMN IF EXISTS convex_creation_time;
ALTER TABLE admin_jobs DROP COLUMN IF EXISTS convex_creation_time;
ALTER TABLE admin_metrics DROP COLUMN IF EXISTS convex_creation_time;
ALTER TABLE admin_database_stats DROP COLUMN IF EXISTS convex_creation_time;
ALTER TABLE admin_audit_log DROP COLUMN IF EXISTS convex_creation_time;
