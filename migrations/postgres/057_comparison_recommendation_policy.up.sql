ALTER TABLE rfpilot.comparison_participant_results
  ALTER COLUMN schema_version SET DEFAULT 'comparison-participant.v3';

ALTER TABLE rfpilot.comparison_snapshots
  ALTER COLUMN schema_version SET DEFAULT 'proposal-intelligence-comparison.v3';
