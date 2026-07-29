ALTER TABLE rfpilot.guidance_reports
  DROP CONSTRAINT IF EXISTS guidance_reports_summary_object_check,
  DROP COLUMN IF EXISTS summary,
  ALTER COLUMN engine_version SET DEFAULT 'guidance-rules.v1';
