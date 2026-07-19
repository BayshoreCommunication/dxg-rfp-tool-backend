CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS rfpilot;

CREATE TABLE rfpilot.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_mongo_id varchar(24) NOT NULL UNIQUE CHECK (external_mongo_id ~ '^[0-9a-f]{24}$'),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rfpilot.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  external_mongo_id varchar(24) NOT NULL CHECK (external_mongo_id ~ '^[0-9a-f]{24}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'removed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, external_mongo_id)
);

CREATE TABLE rfpilot.proposal_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  owner_user_id uuid NOT NULL REFERENCES rfpilot.users(id) ON DELETE RESTRICT,
  external_mongo_id varchar(24) NOT NULL CHECK (external_mongo_id ~ '^[0-9a-f]{24}$'),
  source_version text,
  source_checksum char(64) CHECK (source_checksum IS NULL OR source_checksum ~ '^[0-9a-f]{64}$'),
  source_updated_at timestamptz,
  reconciled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, external_mongo_id)
);

CREATE TABLE rfpilot.ai_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  proposal_reference_id uuid REFERENCES rfpilot.proposal_references(id) ON DELETE RESTRICT,
  job_type text NOT NULL CHECK (length(job_type) BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','cancelled','dead_letter')),
  idempotency_key text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key)
);

CREATE TABLE rfpilot.ai_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  job_id uuid REFERENCES rfpilot.ai_jobs(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  schema_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('started','succeeded','failed','cancelled')),
  input_tokens integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cost_micros bigint CHECK (cost_micros IS NULL OR cost_micros >= 0),
  correlation_id text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rfpilot.provenance_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  proposal_reference_id uuid REFERENCES rfpilot.proposal_references(id) ON DELETE RESTRICT,
  source_type text NOT NULL,
  source_locator text NOT NULL,
  content_checksum char(64) NOT NULL CHECK (content_checksum ~ '^[0-9a-f]{64}$'),
  source_version text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, source_type, source_locator, content_checksum)
);

CREATE TABLE rfpilot.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  actor_external_user_id varchar(24) CHECK (actor_external_user_id IS NULL OR actor_external_user_id ~ '^[0-9a-f]{24}$'),
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  decision text NOT NULL,
  reason text,
  correlation_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rfpilot.outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  event_type text NOT NULL,
  event_version integer NOT NULL DEFAULT 1 CHECK (event_version > 0),
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','publishing','published','failed','dead_letter')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  published_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key)
);

CREATE TABLE rfpilot.migration_journal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id text NOT NULL,
  migration_type text NOT NULL,
  source_system text NOT NULL,
  source_count integer NOT NULL CHECK (source_count >= 0),
  applied_count integer NOT NULL CHECK (applied_count >= 0),
  conflict_count integer NOT NULL CHECK (conflict_count >= 0),
  checksum char(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  outcome text NOT NULL CHECK (outcome IN ('dry_run','applied','rolled_back','failed')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, migration_type, outcome)
);

CREATE INDEX proposal_refs_owner_idx ON rfpilot.proposal_references (organization_id, owner_user_id);
CREATE INDEX ai_jobs_status_idx ON rfpilot.ai_jobs (organization_id, status, available_at);
CREATE INDEX ai_runs_job_idx ON rfpilot.ai_runs (organization_id, job_id, created_at DESC);
CREATE INDEX provenance_proposal_idx ON rfpilot.provenance_records (organization_id, proposal_reference_id);
CREATE INDEX audit_events_tenant_time_idx ON rfpilot.audit_events (organization_id, occurred_at DESC, id DESC);
CREATE INDEX outbox_pending_idx ON rfpilot.outbox_events (status, available_at, created_at) WHERE status IN ('pending','failed');

ALTER TABLE rfpilot.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.users FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.proposal_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.proposal_references FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.ai_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.ai_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.ai_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.ai_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.provenance_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.provenance_records FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.audit_events FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.outbox_events FORCE ROW LEVEL SECURITY;

CREATE FUNCTION rfpilot.current_organization_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.organization_id', true), '')::uuid $$;

CREATE POLICY tenant_isolation_users ON rfpilot.users USING (organization_id = rfpilot.current_organization_id()) WITH CHECK (organization_id = rfpilot.current_organization_id());
CREATE POLICY tenant_isolation_proposal_refs ON rfpilot.proposal_references USING (organization_id = rfpilot.current_organization_id()) WITH CHECK (organization_id = rfpilot.current_organization_id());
CREATE POLICY tenant_isolation_ai_jobs ON rfpilot.ai_jobs USING (organization_id = rfpilot.current_organization_id()) WITH CHECK (organization_id = rfpilot.current_organization_id());
CREATE POLICY tenant_isolation_ai_runs ON rfpilot.ai_runs USING (organization_id = rfpilot.current_organization_id()) WITH CHECK (organization_id = rfpilot.current_organization_id());
CREATE POLICY tenant_isolation_provenance ON rfpilot.provenance_records USING (organization_id = rfpilot.current_organization_id()) WITH CHECK (organization_id = rfpilot.current_organization_id());
CREATE POLICY tenant_isolation_audit ON rfpilot.audit_events USING (organization_id = rfpilot.current_organization_id()) WITH CHECK (organization_id = rfpilot.current_organization_id());
CREATE POLICY tenant_isolation_outbox ON rfpilot.outbox_events USING (organization_id = rfpilot.current_organization_id()) WITH CHECK (organization_id = rfpilot.current_organization_id());

CREATE FUNCTION rfpilot.reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_events are append-only'; END $$;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON rfpilot.audit_events FOR EACH ROW EXECUTE FUNCTION rfpilot.reject_audit_mutation();
