ALTER TABLE rfpilot.guidance_reports
  ADD COLUMN room_schedule_analysis jsonb NOT NULL DEFAULT '{}'::jsonb,
  ALTER COLUMN engine_version SET DEFAULT 'proposal-analysis.v3';

ALTER TABLE rfpilot.guidance_reports
  ADD CONSTRAINT guidance_reports_room_schedule_analysis_object_check
  CHECK (jsonb_typeof(room_schedule_analysis) = 'object');
