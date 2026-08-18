ALTER TABLE rfpilot.requirements
  ADD COLUMN included boolean NOT NULL DEFAULT true,
  ADD COLUMN inclusion_reviewed boolean NOT NULL DEFAULT true;

UPDATE rfpilot.requirements r
SET inclusion_reviewed=false
FROM rfpilot.requirement_sets s
WHERE s.id=r.requirement_set_id AND s.status IN ('draft','in_review');

ALTER TABLE rfpilot.requirements
  ALTER COLUMN inclusion_reviewed SET DEFAULT false;
