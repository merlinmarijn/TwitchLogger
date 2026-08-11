-- Keep the applied ClickHouse migration history intact while removing the
-- PostgreSQL capture machinery introduced for the retired mirror.
DO $$
DECLARE
  mirror_trigger record;
BEGIN
  FOR mirror_trigger IN
    SELECT namespace.nspname AS schema_name, class.relname AS table_name
    FROM pg_trigger AS trigger
    JOIN pg_class AS class ON class.oid = trigger.tgrelid
    JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
    WHERE namespace.nspname = 'public'
      AND trigger.tgname = 'clickhouse_mirror_change'
      AND NOT trigger.tgisinternal
  LOOP
    EXECUTE format(
      'DROP TRIGGER clickhouse_mirror_change ON %I.%I',
      mirror_trigger.schema_name,
      mirror_trigger.table_name
    );
  END LOOP;
END;
$$;

DROP FUNCTION IF EXISTS ensure_clickhouse_mirror_triggers();
DROP FUNCTION IF EXISTS clickhouse_capture_change();
DROP TABLE IF EXISTS clickhouse_mirror_state;
DROP TABLE IF EXISTS clickhouse_mirror_outbox;
DROP SEQUENCE IF EXISTS clickhouse_mirror_version_seq;
