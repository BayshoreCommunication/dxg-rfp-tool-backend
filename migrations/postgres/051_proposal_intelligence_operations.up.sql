CREATE TABLE rfpilot.proposal_intelligence_retention_policies (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL UNIQUE REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  procurement_record_retention_days integer NOT NULL DEFAULT 2555 CHECK (procurement_record_retention_days BETWEEN 365 AND 3650),
  policy_basis text NOT NULL CHECK (char_length(trim(policy_basis)) BETWEEN 20 AND 2000),
  policy_version text NOT NULL DEFAULT 'proposal-intelligence-retention.v1',
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by_external_user_id varchar(24) NOT NULL CHECK (updated_by_external_user_id ~ '^[0-9a-f]{24}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,id)
);

CREATE TABLE rfpilot.proposal_intelligence_legal_hold_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  hold_id uuid NOT NULL,
  comparison_run_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('placed','released')),
  reason text NOT NULL CHECK (char_length(trim(reason)) BETWEEN 20 AND 2000),
  actor_external_user_id varchar(24) NOT NULL CHECK (actor_external_user_id ~ '^[0-9a-f]{24}$'),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 240),
  correlation_id text NOT NULL CHECK (char_length(correlation_id) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,id),
  UNIQUE (organization_id,idempotency_key),
  FOREIGN KEY (organization_id,comparison_run_id) REFERENCES rfpilot.comparison_runs(organization_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX proposal_intelligence_active_hold_once_idx
  ON rfpilot.proposal_intelligence_legal_hold_events(organization_id,hold_id,action);
CREATE INDEX proposal_intelligence_holds_run_idx
  ON rfpilot.proposal_intelligence_legal_hold_events(comparison_run_id,created_at DESC,id DESC);

CREATE TABLE rfpilot.comparison_clarification_sets (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  comparison_run_id uuid NOT NULL,
  set_version integer NOT NULL CHECK (set_version > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','dispatch_recorded')),
  manifest_checksum char(64) NOT NULL CHECK (manifest_checksum ~ '^[0-9a-f]{64}$'),
  content_checksum char(64) NOT NULL CHECK (content_checksum ~ '^[0-9a-f]{64}$'),
  lock_version integer NOT NULL DEFAULT 1 CHECK (lock_version > 0),
  created_by_external_user_id varchar(24) NOT NULL CHECK (created_by_external_user_id ~ '^[0-9a-f]{24}$'),
  approved_by_external_user_id varchar(24) CHECK (approved_by_external_user_id IS NULL OR approved_by_external_user_id ~ '^[0-9a-f]{24}$'),
  approved_at timestamptz,
  dispatch_recorded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,id),
  UNIQUE (comparison_run_id,set_version),
  FOREIGN KEY (organization_id,comparison_run_id) REFERENCES rfpilot.comparison_runs(organization_id,id) ON DELETE RESTRICT,
  CHECK ((status='draft' AND approved_at IS NULL AND approved_by_external_user_id IS NULL) OR (status<>'draft' AND approved_at IS NOT NULL AND approved_by_external_user_id IS NOT NULL)),
  CHECK ((status='dispatch_recorded' AND dispatch_recorded_at IS NOT NULL) OR (status<>'dispatch_recorded' AND dispatch_recorded_at IS NULL))
);

CREATE TABLE rfpilot.comparison_clarification_questions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  clarification_set_id uuid NOT NULL,
  risk_id uuid NOT NULL,
  participant_id uuid NOT NULL,
  vendor_label text NOT NULL CHECK (char_length(vendor_label) BETWEEN 1 AND 255),
  question text NOT NULL CHECK (char_length(trim(question)) BETWEEN 1 AND 1000),
  disposition text NOT NULL DEFAULT 'included' CHECK (disposition IN ('included','excluded')),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,id),
  UNIQUE (clarification_set_id,risk_id),
  UNIQUE (clarification_set_id,ordinal),
  FOREIGN KEY (organization_id,clarification_set_id) REFERENCES rfpilot.comparison_clarification_sets(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,risk_id) REFERENCES rfpilot.evaluation_risks(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,participant_id) REFERENCES rfpilot.comparison_participants(organization_id,id) ON DELETE RESTRICT
);

CREATE TABLE rfpilot.comparison_clarification_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  clarification_set_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('created','question_updated','approved','dispatch_recorded')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload)='object'),
  actor_external_user_id varchar(24) NOT NULL CHECK (actor_external_user_id ~ '^[0-9a-f]{24}$'),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 240),
  correlation_id text NOT NULL CHECK (char_length(correlation_id) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,id),
  UNIQUE (organization_id,idempotency_key),
  FOREIGN KEY (organization_id,clarification_set_id) REFERENCES rfpilot.comparison_clarification_sets(organization_id,id) ON DELETE RESTRICT
);

CREATE TABLE rfpilot.comparison_report_exports (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  comparison_run_id uuid NOT NULL,
  report_type text NOT NULL CHECK (report_type IN ('executive_html','executive_pdf','comparison_xlsx','evaluator_html','decision_html','clarification_html','audit_json')),
  media_type text NOT NULL CHECK (char_length(media_type) BETWEEN 3 AND 150),
  manifest_checksum char(64) NOT NULL CHECK (manifest_checksum ~ '^[0-9a-f]{64}$'),
  content_checksum char(64) NOT NULL CHECK (content_checksum ~ '^[0-9a-f]{64}$'),
  freshness_state text NOT NULL CHECK (freshness_state IN ('current','stale')),
  permission_snapshot jsonb NOT NULL CHECK (jsonb_typeof(permission_snapshot)='object'),
  byte_size integer NOT NULL CHECK (byte_size > 0),
  actor_external_user_id varchar(24) NOT NULL CHECK (actor_external_user_id ~ '^[0-9a-f]{24}$'),
  correlation_id text NOT NULL CHECK (char_length(correlation_id) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,id),
  FOREIGN KEY (organization_id,comparison_run_id) REFERENCES rfpilot.comparison_runs(organization_id,id) ON DELETE RESTRICT
);
CREATE INDEX comparison_report_exports_run_idx ON rfpilot.comparison_report_exports(comparison_run_id,created_at DESC,id DESC);
CREATE INDEX comparison_clarification_sets_run_idx ON rfpilot.comparison_clarification_sets(comparison_run_id,created_at DESC,id DESC);

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'proposal_intelligence_retention_policies','proposal_intelligence_legal_hold_events',
    'comparison_clarification_sets','comparison_clarification_questions','comparison_clarification_events','comparison_report_exports'
  ] LOOP
    EXECUTE format('ALTER TABLE rfpilot.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE rfpilot.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY tenant_%I ON rfpilot.%I USING (organization_id=rfpilot.current_organization_id()) WITH CHECK (organization_id=rfpilot.current_organization_id())',table_name,table_name);
  END LOOP;
END $$;

CREATE FUNCTION rfpilot.guard_proposal_intelligence_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'proposal intelligence event records are immutable'; END $$;
CREATE TRIGGER proposal_intelligence_holds_immutable BEFORE UPDATE OR DELETE ON rfpilot.proposal_intelligence_legal_hold_events FOR EACH ROW EXECUTE FUNCTION rfpilot.guard_proposal_intelligence_event_immutable();
CREATE TRIGGER comparison_clarification_events_immutable BEFORE UPDATE OR DELETE ON rfpilot.comparison_clarification_events FOR EACH ROW EXECUTE FUNCTION rfpilot.guard_proposal_intelligence_event_immutable();
CREATE TRIGGER comparison_report_exports_immutable BEFORE UPDATE OR DELETE ON rfpilot.comparison_report_exports FOR EACH ROW EXECUTE FUNCTION rfpilot.guard_proposal_intelligence_event_immutable();

CREATE FUNCTION rfpilot.guard_clarification_question_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE set_status text;
BEGIN
  SELECT status INTO set_status FROM rfpilot.comparison_clarification_sets WHERE id=OLD.clarification_set_id;
  IF set_status <> 'draft' THEN RAISE EXCEPTION 'approved clarification questions are immutable'; END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'clarification questions cannot be deleted'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER clarification_questions_frozen BEFORE UPDATE OR DELETE ON rfpilot.comparison_clarification_questions FOR EACH ROW EXECUTE FUNCTION rfpilot.guard_clarification_question_mutation();
