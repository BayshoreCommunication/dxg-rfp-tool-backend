DROP TABLE IF EXISTS rfpilot.proposal_draft_section_decisions;
DROP INDEX IF EXISTS rfpilot.proposal_draft_runs_parent_idx;
ALTER TABLE rfpilot.proposal_draft_runs DROP COLUMN IF EXISTS section_scope, DROP COLUMN IF EXISTS parent_run_id;
