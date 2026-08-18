ALTER TABLE rfpilot.requirement_sets
  ALTER COLUMN generator_version SET DEFAULT 'requirement-registry.v1';

ALTER TABLE rfpilot.comparison_participant_results
  ALTER COLUMN schema_version SET DEFAULT 'comparison-participant.v3';

ALTER TABLE rfpilot.comparison_snapshots
  ALTER COLUMN schema_version SET DEFAULT 'proposal-intelligence-comparison.v3';
