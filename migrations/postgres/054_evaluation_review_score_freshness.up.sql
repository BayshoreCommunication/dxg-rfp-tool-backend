ALTER TABLE rfpilot.vendor_evaluation_runs
  ADD COLUMN review_input_checksum char(64) NOT NULL DEFAULT repeat('0',64)
  CHECK (review_input_checksum ~ '^[0-9a-f]{64}$');

ALTER TABLE rfpilot.vendor_evaluation_runs
  DROP CONSTRAINT IF EXISTS vendor_evaluation_runs_intelligence_run_id_key;

ALTER TABLE rfpilot.vendor_evaluation_runs
  ADD CONSTRAINT vendor_evaluation_runs_frozen_input_unique
  UNIQUE (intelligence_run_id,matrix_version_id,sealed_price,review_input_checksum,scoring_policy_version);

ALTER TABLE rfpilot.vendor_evaluation_runs
  ALTER COLUMN assessment_version SET DEFAULT 'vendor-assessment.v2';
