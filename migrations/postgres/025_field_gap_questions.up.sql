-- Clarification questions could only originate from an extraction run, so a
-- proposal started by conversation alone was never asked anything. Questions
-- may now come from empty high-impact fields, with no run attached.
ALTER TABLE rfpilot.clarification_questions ALTER COLUMN context_run_id DROP NOT NULL;
CREATE UNIQUE INDEX clarification_questions_field_gap_idx
 ON rfpilot.clarification_questions(proposal_reference_id, issue_code)
 WHERE context_run_id IS NULL;
