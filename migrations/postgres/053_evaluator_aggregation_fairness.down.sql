ALTER TABLE rfpilot.vendor_evaluation_runs
  ALTER COLUMN scoring_policy_version SET DEFAULT 'confirmed-rubric-score.v1';

ALTER TABLE rfpilot.comparison_participant_results
  ALTER COLUMN schema_version SET DEFAULT 'comparison-participant.v1';

ALTER TABLE rfpilot.comparison_snapshots
  ALTER COLUMN schema_version SET DEFAULT 'proposal-intelligence-comparison.v1';
