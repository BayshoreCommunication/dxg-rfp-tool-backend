ALTER TABLE rfpilot.vendor_evaluation_runs
  DROP CONSTRAINT IF EXISTS vendor_evaluation_runs_policy_input_unique;

ALTER TABLE rfpilot.vendor_evaluation_runs
  ADD CONSTRAINT vendor_evaluation_runs_frozen_input_unique
  UNIQUE (
    intelligence_run_id,
    matrix_version_id,
    sealed_price,
    review_input_checksum,
    scoring_policy_version
  );
