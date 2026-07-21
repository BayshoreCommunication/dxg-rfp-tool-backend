DROP INDEX IF EXISTS rfpilot.proposal_context_source_idx;
ALTER TABLE rfpilot.proposal_context_runs DROP COLUMN source_id;
ALTER TABLE rfpilot.proposal_context_runs ALTER COLUMN fixture SET NOT NULL;
ALTER TABLE rfpilot.document_sources DROP CONSTRAINT document_sources_confidentiality_check;
ALTER TABLE rfpilot.document_sources ADD CONSTRAINT document_sources_confidentiality_check CHECK(confidentiality IN('internal','confidential','restricted'));
