CREATE TABLE rfpilot.ai_provider_attempts(
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id),
 run_type text NOT NULL CHECK(run_type IN('proposal_context','proposal_draft')),
 run_id uuid NOT NULL,
 attempt_number integer NOT NULL CHECK(attempt_number>=1),
 attempt_fingerprint text NOT NULL UNIQUE,
 state text NOT NULL CHECK(state IN('pending_call','succeeded','failed','orphaned')),
 provider text NOT NULL CHECK(provider IN('openai')),
 model text NOT NULL,
 operation text NOT NULL CHECK(operation IN('extractStructured','generateFromEvidence')),
 input_tokens integer,
 output_tokens integer,
 provider_request_id text,
 error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(run_type,run_id,attempt_number)
);
ALTER TABLE rfpilot.ai_provider_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.ai_provider_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_ai_provider_attempts ON rfpilot.ai_provider_attempts USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());
CREATE INDEX ai_provider_attempts_run_idx ON rfpilot.ai_provider_attempts(run_type,run_id);
CREATE INDEX ai_provider_attempts_org_time_idx ON rfpilot.ai_provider_attempts(organization_id,created_at DESC);
