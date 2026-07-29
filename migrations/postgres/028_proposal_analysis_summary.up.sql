ALTER TABLE rfpilot.guidance_reports
  ADD COLUMN summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  ALTER COLUMN engine_version SET DEFAULT 'proposal-analysis.v2';

ALTER TABLE rfpilot.guidance_reports
  ADD CONSTRAINT guidance_reports_summary_object_check
  CHECK (jsonb_typeof(summary) = 'object');
