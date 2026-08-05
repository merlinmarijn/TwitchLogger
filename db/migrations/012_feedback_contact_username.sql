ALTER TABLE feedback_reports
  ADD COLUMN IF NOT EXISTS contact_username varchar(25);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'feedback_reports_contact_username_check'
      AND conrelid = 'feedback_reports'::regclass
  ) THEN
    ALTER TABLE feedback_reports
      ADD CONSTRAINT feedback_reports_contact_username_check
      CHECK (
        contact_username IS NULL OR
        contact_username ~ '^[a-z0-9_]{1,25}$'
      );
  END IF;
END $$;
