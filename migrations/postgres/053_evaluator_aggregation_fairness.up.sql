ALTER TABLE rfpilot.vendor_evaluation_runs
  ALTER COLUMN scoring_policy_version SET DEFAULT 'confirmed-rubric-score.v2';

ALTER TABLE rfpilot.comparison_participant_results
  ALTER COLUMN schema_version SET DEFAULT 'comparison-participant.v2';

ALTER TABLE rfpilot.comparison_snapshots
  ALTER COLUMN schema_version SET DEFAULT 'proposal-intelligence-comparison.v2';
