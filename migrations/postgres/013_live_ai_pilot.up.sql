ALTER TABLE rfpilot.proposal_context_runs DROP CONSTRAINT proposal_context_runs_provider_check;
ALTER TABLE rfpilot.proposal_context_runs DROP CONSTRAINT proposal_context_runs_model_check;
ALTER TABLE rfpilot.proposal_context_runs ADD CONSTRAINT proposal_context_runs_provider_check CHECK(provider IN('mock','openai'));
ALTER TABLE rfpilot.proposal_context_runs ADD COLUMN input_tokens integer,ADD COLUMN output_tokens integer,ADD COLUMN provider_request_id text;

ALTER TABLE rfpilot.proposal_draft_runs DROP CONSTRAINT proposal_draft_runs_provider_check;
ALTER TABLE rfpilot.proposal_draft_runs DROP CONSTRAINT proposal_draft_runs_model_check;
ALTER TABLE rfpilot.proposal_draft_runs ADD CONSTRAINT proposal_draft_runs_provider_check CHECK(provider IN('mock','openai'));
ALTER TABLE rfpilot.proposal_draft_runs ADD COLUMN input_tokens integer,ADD COLUMN output_tokens integer,ADD COLUMN provider_request_id text;

CREATE TABLE rfpilot.ai_kill_switches(
 id uuid PRIMARY KEY,organization_id uuid REFERENCES rfpilot.organizations(id),scope text NOT NULL CHECK(scope IN('global','organization','extractStructured','generateFromEvidence')),enabled boolean NOT NULL DEFAULT false,reason text NOT NULL DEFAULT '',updated_by_external_user_id varchar(24),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(organization_id,scope)
);
ALTER TABLE rfpilot.ai_kill_switches ENABLE ROW LEVEL SECURITY;ALTER TABLE rfpilot.ai_kill_switches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_ai_kill_switches ON rfpilot.ai_kill_switches USING(organization_id IS NULL OR organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());
CREATE INDEX live_context_usage_idx ON rfpilot.proposal_context_runs(organization_id,provider,created_at DESC) WHERE provider='openai';
CREATE INDEX live_draft_usage_idx ON rfpilot.proposal_draft_runs(organization_id,provider,created_at DESC) WHERE provider='openai';
