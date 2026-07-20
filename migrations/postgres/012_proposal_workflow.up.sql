CREATE TABLE rfpilot.proposal_workflows (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id),
  proposal_reference_id uuid NOT NULL REFERENCES rfpilot.proposal_references(id),
  owner_external_user_id varchar(24) NOT NULL CHECK(owner_external_user_id ~ '^[0-9a-f]{24}$'),
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','abandoned')),
  current_step smallint NOT NULL DEFAULT 1 CHECK(current_step BETWEEN 1 AND 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id, proposal_reference_id)
);

CREATE INDEX proposal_workflows_owner_idx ON rfpilot.proposal_workflows(organization_id,owner_external_user_id,updated_at DESC);
ALTER TABLE rfpilot.proposal_workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.proposal_workflows FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_proposal_workflows ON rfpilot.proposal_workflows
  USING(organization_id=rfpilot.current_organization_id())
  WITH CHECK(organization_id=rfpilot.current_organization_id());
