ALTER TABLE rfpilot.guidance_reports
  DROP CONSTRAINT IF EXISTS guidance_reports_room_schedule_analysis_object_check,
  DROP COLUMN IF EXISTS room_schedule_analysis,
  ALTER COLUMN engine_version SET DEFAULT 'proposal-analysis.v2';
