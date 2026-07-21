CREATE TABLE rfpilot.proposal_context_run_sources(
  run_id uuid NOT NULL REFERENCES rfpilot.proposal_context_runs(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  source_id uuid NOT NULL REFERENCES rfpilot.document_sources(id) ON DELETE RESTRICT,
  ordinal smallint NOT NULL CHECK(ordinal BETWEEN 0 AND 4),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(run_id,source_id),
  UNIQUE(run_id,ordinal)
);
ALTER TABLE rfpilot.proposal_context_run_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.proposal_context_run_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY proposal_context_run_sources_tenant ON rfpilot.proposal_context_run_sources USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());
INSERT INTO rfpilot.proposal_context_run_sources(run_id,organization_id,source_id,ordinal)
SELECT id,organization_id,source_id,0 FROM rfpilot.proposal_context_runs WHERE source_id IS NOT NULL;
