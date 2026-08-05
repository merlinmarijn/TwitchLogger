ALTER TABLE feedback_reports
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS flags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS closed_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'feedback_reports_status_check'
      AND conrelid = 'feedback_reports'::regclass
  ) THEN
    ALTER TABLE feedback_reports
      ADD CONSTRAINT feedback_reports_status_check
      CHECK (status IN ('open', 'closed'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'feedback_reports_flags_check'
      AND conrelid = 'feedback_reports'::regclass
  ) THEN
    ALTER TABLE feedback_reports
      ADD CONSTRAINT feedback_reports_flags_check
      CHECK (flags <@ ARRAY[
        'needs-review', 'needs-info', 'duplicate', 'non-issue',
        'feature-request', 'improvement', 'question', 'support', 'documentation',
        'urgent', 'high-priority', 'low-priority',
        'usability', 'accessibility', 'performance', 'security', 'mobile',
        'desktop', 'data-quality', 'integration', 'quick-win', 'planned',
        'in-progress', 'blocked', 'wont-do'
      ]::text[]);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'feedback_reports_non_issue_kind_check'
      AND conrelid = 'feedback_reports'::regclass
  ) THEN
    ALTER TABLE feedback_reports
      ADD CONSTRAINT feedback_reports_non_issue_kind_check
      CHECK (kind = 'issue' OR NOT flags @> ARRAY['non-issue']::text[]);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS feedback_reports_status_kind_created_idx
  ON feedback_reports (status, kind, created_at DESC);

CREATE INDEX IF NOT EXISTS feedback_reports_flags_idx
  ON feedback_reports USING gin (flags);
