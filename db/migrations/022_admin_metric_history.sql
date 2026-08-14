CREATE TABLE IF NOT EXISTS admin_metric_samples (
  bucket_start bigint PRIMARY KEY,
  function_calls bigint NOT NULL DEFAULT 0,
  error_count bigint NOT NULL DEFAULT 0,
  total_execution_ms double precision NOT NULL DEFAULT 0,
  cache_hits bigint NOT NULL DEFAULT 0,
  cache_misses bigint NOT NULL DEFAULT 0
);
