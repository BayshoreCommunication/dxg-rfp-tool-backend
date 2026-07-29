CREATE UNIQUE INDEX IF NOT EXISTS proposal_references_org_id_uq
  ON rfpilot.proposal_references(organization_id,id);

CREATE TABLE rfpilot.historical_insight_reports (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  current_proposal_reference_id uuid NOT NULL,
  actor_external_user_id varchar(24) NOT NULL CHECK(actor_external_user_id~'^[0-9a-f]{24}$'),
  current_proposal_version integer NOT NULL CHECK(current_proposal_version>0),
  analysis_version text NOT NULL CHECK(length(analysis_version) BETWEEN 1 AND 100),
  reference_summary jsonb NOT NULL CHECK(jsonb_typeof(reference_summary)='array'),
  section_comparisons jsonb NOT NULL CHECK(jsonb_typeof(section_comparisons)='array'),
  insights jsonb NOT NULL CHECK(jsonb_typeof(insights)='array'),
  privacy_summary jsonb NOT NULL CHECK(jsonb_typeof(privacy_summary)='object'),
  correlation_id text NOT NULL CHECK(length(correlation_id) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,current_proposal_reference_id)
    REFERENCES rfpilot.proposal_references(organization_id,id) ON DELETE RESTRICT
);

CREATE TABLE rfpilot.historical_insight_report_references (
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  report_id uuid NOT NULL REFERENCES rfpilot.historical_insight_reports(id) ON DELETE CASCADE,
  reference_proposal_reference_id uuid NOT NULL,
  ordinal smallint NOT NULL CHECK(ordinal BETWEEN 1 AND 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(report_id,reference_proposal_reference_id),
  UNIQUE(report_id,ordinal),
  FOREIGN KEY(organization_id,reference_proposal_reference_id)
    REFERENCES rfpilot.proposal_references(organization_id,id) ON DELETE RESTRICT
);

CREATE INDEX historical_insight_reports_current_idx
  ON rfpilot.historical_insight_reports(
    organization_id,current_proposal_reference_id,created_at DESC
  );
CREATE INDEX historical_insight_links_reference_idx
  ON rfpilot.historical_insight_report_references(
    organization_id,reference_proposal_reference_id
  );

ALTER TABLE rfpilot.historical_insight_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.historical_insight_reports FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.historical_insight_report_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.historical_insight_report_references FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_historical_insight_reports
  ON rfpilot.historical_insight_reports
  USING(organization_id=rfpilot.current_organization_id())
  WITH CHECK(organization_id=rfpilot.current_organization_id());
CREATE POLICY tenant_isolation_historical_insight_links
  ON rfpilot.historical_insight_report_references
  USING(organization_id=rfpilot.current_organization_id())
  WITH CHECK(organization_id=rfpilot.current_organization_id());
