UPDATE rfpilot.evaluation_assignments
SET conflict_status='pending',
    conflict_note='',
    status='open',
    version=version+1,
    updated_at=now()
WHERE conflict_status='not_applicable';

ALTER TABLE rfpilot.evaluation_assignments
  DROP CONSTRAINT IF EXISTS evaluation_assignments_conflict_status_check;

ALTER TABLE rfpilot.evaluation_assignments
  ADD CONSTRAINT evaluation_assignments_conflict_status_check
  CHECK (conflict_status IN ('pending','clear','conflict'));
