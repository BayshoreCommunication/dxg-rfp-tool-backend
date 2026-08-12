CREATE TABLE rfpilot.comparison_decisions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  comparison_run_id uuid NOT NULL,
  decision_type text NOT NULL CHECK (decision_type IN ('shortlist','selection','no_award')),
  selected_participant_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(selected_participant_ids)='array'),
  rationale text NOT NULL CHECK (char_length(trim(rationale)) BETWEEN 20 AND 5000),
  stale_acknowledged boolean NOT NULL DEFAULT false,
  manifest_checksum char(64) NOT NULL CHECK (manifest_checksum ~ '^[0-9a-f]{64}$'),
  supersedes_decision_id uuid,
  actor_external_user_id varchar(24) NOT NULL CHECK (actor_external_user_id ~ '^[0-9a-f]{24}$'),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 240),
  correlation_id text NOT NULL CHECK (char_length(correlation_id) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,id),
  UNIQUE (organization_id,idempotency_key),
  FOREIGN KEY (organization_id,comparison_run_id)
    REFERENCES rfpilot.comparison_runs(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,supersedes_decision_id)
    REFERENCES rfpilot.comparison_decisions(organization_id,id) ON DELETE RESTRICT
);

CREATE INDEX comparison_decisions_run_idx
  ON rfpilot.comparison_decisions(comparison_run_id,created_at DESC,id DESC);

ALTER TABLE rfpilot.comparison_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.comparison_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_comparison_decisions ON rfpilot.comparison_decisions
  USING (organization_id=rfpilot.current_organization_id())
  WITH CHECK (organization_id=rfpilot.current_organization_id());

CREATE FUNCTION rfpilot.guard_comparison_decision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'comparison decision records are immutable';
END $$;
CREATE TRIGGER comparison_decisions_immutable
  BEFORE UPDATE OR DELETE ON rfpilot.comparison_decisions
  FOR EACH ROW EXECUTE FUNCTION rfpilot.guard_comparison_decision_immutable();
