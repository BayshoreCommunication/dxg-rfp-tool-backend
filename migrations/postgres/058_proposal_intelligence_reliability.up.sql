ALTER TABLE rfpilot.requirement_sets
  ALTER COLUMN generator_version SET DEFAULT 'requirement-registry.v2';

ALTER TABLE rfpilot.comparison_participant_results
  ALTER COLUMN schema_version SET DEFAULT 'comparison-participant.v4';

ALTER TABLE rfpilot.comparison_snapshots
  ALTER COLUMN schema_version SET DEFAULT 'proposal-intelligence-comparison.v4';
