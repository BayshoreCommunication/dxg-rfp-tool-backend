ALTER TABLE rfpilot.proposal_draft_runs
 ADD COLUMN parent_run_id uuid REFERENCES rfpilot.proposal_draft_runs(id),
 ADD COLUMN section_scope text CHECK(section_scope IS NULL OR section_scope IN('event_overview','objectives_audience','format_experience','venue_schedule','production_scope','known_requirements','information_gaps'));
CREATE INDEX proposal_draft_runs_parent_idx ON rfpilot.proposal_draft_runs(parent_run_id) WHERE parent_run_id IS NOT NULL;

CREATE TABLE rfpilot.proposal_draft_section_decisions(
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
 run_id uuid NOT NULL REFERENCES rfpilot.proposal_draft_runs(id) ON DELETE RESTRICT,
 section_key text NOT NULL CHECK(section_key IN('event_overview','objectives_audience','format_experience','venue_schedule','production_scope','known_requirements','information_gaps')),
 decision text NOT NULL CHECK(decision IN('accepted','rejected')),
 decided_by_external_user_id varchar(24) NOT NULL CHECK(decided_by_external_user_id~'^[0-9a-f]{24}$'),
 reason text NOT NULL DEFAULT '' CHECK(char_length(reason)<=500),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(run_id,section_key)
);
ALTER TABLE rfpilot.proposal_draft_section_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.proposal_draft_section_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_proposal_draft_section_decisions ON rfpilot.proposal_draft_section_decisions USING(organization_id=rfpilot.current_organization_id()) WITH CHECK(organization_id=rfpilot.current_organization_id());
CREATE INDEX proposal_draft_section_decisions_run_idx ON rfpilot.proposal_draft_section_decisions(run_id);
