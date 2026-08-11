-- Store primary-key values as text so bigint identities remain exact when the
-- JSON outbox is decoded by JavaScript. PostgreSQL infers the original type
-- again when the mirror fetches the source row.
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
    key_data := key_data || jsonb_build_object(key_column, source_row ->> key_column);
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
