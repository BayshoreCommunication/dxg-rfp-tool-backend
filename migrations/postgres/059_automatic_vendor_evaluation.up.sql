ALTER TABLE rfpilot.evaluation_assignments
  DROP CONSTRAINT IF EXISTS evaluation_assignments_conflict_status_check;

ALTER TABLE rfpilot.evaluation_assignments
  ADD CONSTRAINT evaluation_assignments_conflict_status_check
  CHECK (conflict_status IN ('pending','clear','conflict','not_applicable'));
