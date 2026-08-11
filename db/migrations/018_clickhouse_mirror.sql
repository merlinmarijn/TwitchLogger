CREATE SEQUENCE IF NOT EXISTS clickhouse_mirror_version_seq;

CREATE TABLE IF NOT EXISTS clickhouse_mirror_outbox (
  source_table text NOT NULL,
  primary_key jsonb NOT NULL,
  version bigint NOT NULL DEFAULT nextval('clickhouse_mirror_version_seq'),
  operation text NOT NULL CHECK (operation IN ('upsert', 'delete')),
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_table, primary_key),
  UNIQUE (version)
);

CREATE INDEX IF NOT EXISTS clickhouse_mirror_outbox_version_idx
  ON clickhouse_mirror_outbox (version);

CREATE TABLE IF NOT EXISTS clickhouse_mirror_state (
  source_table text PRIMARY KEY,
  schema_signature text NOT NULL,
  backfill_version bigint NOT NULL,
  backfilled_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION clickhouse_capture_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_row jsonb;
  key_data jsonb := '{}'::jsonb;
  key_column text;
BEGIN
  source_row := to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END);
  FOREACH key_column IN ARRAY TG_ARGV LOOP
    key_data := key_data || jsonb_build_object(key_column, source_row -> key_column);
  END LOOP;

  INSERT INTO clickhouse_mirror_outbox (
    source_table,
    primary_key,
    operation
  ) VALUES (
    TG_TABLE_NAME,
    key_data,
    CASE WHEN TG_OP = 'DELETE' THEN 'delete' ELSE 'upsert' END
  )
  ON CONFLICT (source_table, primary_key) DO UPDATE
  SET version = EXCLUDED.version,
      operation = EXCLUDED.operation,
      changed_at = now();

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION ensure_clickhouse_mirror_triggers()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  source record;
  trigger_arguments text;
BEGIN
  FOR source IN
    SELECT class.oid, namespace.nspname AS schema_name, class.relname AS table_name
    FROM pg_class AS class
    JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
    WHERE namespace.nspname = 'public'
      AND class.relkind IN ('r', 'p')
      AND class.relname NOT IN ('clickhouse_mirror_outbox', 'clickhouse_mirror_state')
  LOOP
    SELECT string_agg(quote_literal(attribute.attname), ', ' ORDER BY key_column.ordinality)
    INTO trigger_arguments
    FROM pg_index AS index
    CROSS JOIN LATERAL unnest(index.indkey) WITH ORDINALITY AS key_column(attribute_number, ordinality)
    JOIN pg_attribute AS attribute
      ON attribute.attrelid = index.indrelid
      AND attribute.attnum = key_column.attribute_number
    WHERE index.indrelid = source.oid
      AND index.indisprimary;

    IF trigger_arguments IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM pg_trigger
      WHERE tgrelid = source.oid
        AND tgname = 'clickhouse_mirror_change'
        AND NOT tgisinternal
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER clickhouse_mirror_change '
        'AFTER INSERT OR UPDATE OR DELETE ON %I.%I '
        'FOR EACH ROW EXECUTE FUNCTION clickhouse_capture_change(%s)',
        source.schema_name,
        source.table_name,
        trigger_arguments
      );
    END IF;
  END LOOP;
END;
$$;

SELECT ensure_clickhouse_mirror_triggers();
