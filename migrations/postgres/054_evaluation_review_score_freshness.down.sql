ALTER TABLE rfpilot.vendor_evaluation_runs
  DROP CONSTRAINT IF EXISTS vendor_evaluation_runs_frozen_input_unique;

ALTER TABLE rfpilot.vendor_evaluation_runs
  ALTER COLUMN assessment_version SET DEFAULT 'vendor-assessment.v1';

ALTER TABLE rfpilot.vendor_evaluation_runs
  DROP COLUMN IF EXISTS review_input_checksum;

ALTER TABLE rfpilot.vendor_evaluation_runs
  ADD CONSTRAINT vendor_evaluation_runs_intelligence_run_id_key UNIQUE (intelligence_run_id);
