CREATE TABLE rfpilot.proposal_context_runs (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
 proposal_reference_id uuid NOT NULL REFERENCES rfpilot.proposal_references(id) ON DELETE RESTRICT,
 job_id uuid NOT NULL UNIQUE REFERENCES rfpilot.ai_jobs(id) ON DELETE RESTRICT,
 actor_external_user_id varchar(24) NOT NULL CHECK(actor_external_user_id ~ '^[0-9a-f]{24}$'),
 fixture text NOT NULL CHECK(fixture IN('synthetic-conference-simple','synthetic-conference-medium','invalid-output','prompt-injection')),
 status text NOT NULL CHECK(status IN('queued','running','succeeded','failed')),
 provider text NOT NULL DEFAULT 'mock' CHECK(provider='mock'), model text NOT NULL DEFAULT 'deterministic-v1' CHECK(model='deterministic-v1'),
 schema_version text NOT NULL DEFAULT 'proposal-extraction-patch.v1', input_checksum char(64) NOT NULL CHECK(input_checksum ~ '^[0-9a-f]{64}$'),
 output_checksum char(64) CHECK(output_checksum IS NULL OR output_checksum ~ '^[0-9a-f]{64}$'), operation_count integer NOT NULL DEFAULT 0 CHECK(operation_count BETWEEN 0 AND 200),
 evidence_count integer NOT NULL DEFAULT 0 CHECK(evidence_count BETWEEN 0 AND 200), issue_count integer NOT NULL DEFAULT 0 CHECK(issue_count BETWEEN 0 AND 100),
 safe_error_code text, correlation_id uuid NOT NULL, retention_until timestamptz NOT NULL,
 started_at timestamptz,completed_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE rfpilot.proposal_context_evidence (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,run_id uuid NOT NULL REFERENCES rfpilot.proposal_context_runs(id) ON DELETE RESTRICT,
 source_version_id text NOT NULL,fragment_id text NOT NULL,locator jsonb NOT NULL,content_checksum char(64) NOT NULL CHECK(content_checksum ~ '^[0-9a-f]{64}$'),ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 199),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(run_id,ordinal)
);
CREATE TABLE rfpilot.proposal_context_operations (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,run_id uuid NOT NULL REFERENCES rfpilot.proposal_context_runs(id) ON DELETE RESTRICT,
 ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 199),operation text NOT NULL CHECK(operation IN('add','replace')),path text NOT NULL CHECK(path ~ '^/content(?:/[A-Za-z0-9_~-]+)+$'),
 value jsonb NOT NULL,confidence numeric(4,3) NOT NULL CHECK(confidence BETWEEN 0 AND 1),evidence_ids uuid[] NOT NULL CHECK(cardinality(evidence_ids)>0),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(run_id,ordinal)
);
CREATE TABLE rfpilot.proposal_context_issues (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,run_id uuid NOT NULL REFERENCES rfpilot.proposal_context_runs(id) ON DELETE RESTRICT,
 ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 99),code text NOT NULL,severity text NOT NULL CHECK(severity IN('info','question','blocking')),paths text[] NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(run_id,ordinal)
);
CREATE INDEX proposal_context_runs_list_idx ON rfpilot.proposal_context_runs(organization_id,proposal_reference_id,created_at DESC);
ALTER TABLE rfpilot.proposal_context_runs ENABLE ROW LEVEL SECURITY;ALTER TABLE rfpilot.proposal_context_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.proposal_context_evidence ENABLE ROW LEVEL SECURITY;ALTER TABLE rfpilot.proposal_context_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.proposal_context_operations ENABLE ROW LEVEL SECURITY;ALTER TABLE rfpilot.proposal_context_operations FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.proposal_context_issues ENABLE ROW LEVEL SECURITY;ALTER TABLE rfpilot.proposal_context_issues FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_proposal_context_runs ON rfpilot.proposal_context_runs USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());
CREATE POLICY tenant_proposal_context_evidence ON rfpilot.proposal_context_evidence USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());
CREATE POLICY tenant_proposal_context_operations ON rfpilot.proposal_context_operations USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());
CREATE POLICY tenant_proposal_context_issues ON rfpilot.proposal_context_issues USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());
CREATE FUNCTION rfpilot.reject_proposal_context_result_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'proposal context result evidence is immutable'; END $$;
CREATE TRIGGER proposal_context_evidence_immutable BEFORE UPDATE OR DELETE ON rfpilot.proposal_context_evidence FOR EACH ROW EXECUTE FUNCTION rfpilot.reject_proposal_context_result_mutation();
CREATE TRIGGER proposal_context_operations_immutable BEFORE UPDATE OR DELETE ON rfpilot.proposal_context_operations FOR EACH ROW EXECUTE FUNCTION rfpilot.reject_proposal_context_result_mutation();
CREATE TRIGGER proposal_context_issues_immutable BEFORE UPDATE OR DELETE ON rfpilot.proposal_context_issues FOR EACH ROW EXECUTE FUNCTION rfpilot.reject_proposal_context_result_mutation();
