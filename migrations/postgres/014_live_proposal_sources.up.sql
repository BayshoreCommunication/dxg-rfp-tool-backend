ALTER TABLE rfpilot.document_sources DROP CONSTRAINT document_sources_confidentiality_check;
ALTER TABLE rfpilot.document_sources ADD CONSTRAINT document_sources_confidentiality_check CHECK(confidentiality IN('non_confidential','internal','confidential','restricted'));
ALTER TABLE rfpilot.proposal_context_runs ADD COLUMN source_id uuid REFERENCES rfpilot.document_sources(id) ON DELETE RESTRICT;
ALTER TABLE rfpilot.proposal_context_runs ALTER COLUMN fixture DROP NOT NULL;
CREATE INDEX proposal_context_source_idx ON rfpilot.proposal_context_runs(organization_id,source_id,created_at DESC) WHERE source_id IS NOT NULL;
