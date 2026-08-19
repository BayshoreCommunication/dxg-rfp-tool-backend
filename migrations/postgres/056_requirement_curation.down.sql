ALTER TABLE rfpilot.requirements
  DROP COLUMN IF EXISTS inclusion_reviewed,
  DROP COLUMN IF EXISTS included;
