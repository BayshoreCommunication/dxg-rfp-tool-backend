DROP INDEX IF EXISTS rfpilot.clarification_questions_field_gap_idx;
DELETE FROM rfpilot.clarification_questions WHERE context_run_id IS NULL;
ALTER TABLE rfpilot.clarification_questions ALTER COLUMN context_run_id SET NOT NULL;
