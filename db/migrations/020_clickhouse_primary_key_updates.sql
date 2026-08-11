-- A primary-key update represents a delete of the old ClickHouse row followed
-- by an upsert of the new row. Most application keys are immutable, but the
-- generic mirror must keep both sides correct when a key does change.
CREATE OR REPLACE FUNCTION clickhouse_capture_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_row jsonb;
  key_data jsonb := '{}'::jsonb;
  old_key_data jsonb := '{}'::jsonb;
  key_column text;
BEGIN
  source_row := to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END);
  FOREACH key_column IN ARRAY TG_ARGV LOOP
    key_data := key_data || jsonb_build_object(key_column, source_row ->> key_column);
    IF TG_OP = 'UPDATE' THEN
      old_key_data := old_key_data || jsonb_build_object(
        key_column,
        to_jsonb(OLD) ->> key_column
      );
    END IF;
  END LOOP;

  IF TG_OP = 'UPDATE' AND old_key_data <> key_data THEN
    INSERT INTO clickhouse_mirror_outbox (
      source_table,
      primary_key,
      operation
    ) VALUES (
      TG_TABLE_NAME,
      old_key_data,
      'delete'
    )
    ON CONFLICT (source_table, primary_key) DO UPDATE
    SET version = EXCLUDED.version,
        operation = EXCLUDED.operation,
        changed_at = now();
  END IF;

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
