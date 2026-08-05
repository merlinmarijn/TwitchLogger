CREATE TABLE IF NOT EXISTS feedback_reports (
  id bigserial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('feedback', 'issue')),
  description text NOT NULL CHECK (
    char_length(btrim(description)) BETWEEN 1 AND 4000
  ),
  ip_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS feedback_reports_ip_created_idx
  ON feedback_reports (ip_hash, created_at DESC);

CREATE INDEX IF NOT EXISTS feedback_reports_created_idx
  ON feedback_reports (created_at DESC);
