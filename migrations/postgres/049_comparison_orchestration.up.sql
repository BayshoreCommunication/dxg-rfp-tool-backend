CREATE TABLE rfpilot.comparison_runs (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  proposal_reference_id uuid NOT NULL,
  requirement_set_id uuid NOT NULL,
  matrix_version_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','succeeded_with_warnings','failed','cancelling','cancelled')),
  progress numeric(6,3) NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  progress_stage text NOT NULL DEFAULT 'participant_snapshots' CHECK (progress_stage IN ('participant_snapshots','aggregation','completed','failed','cancelling','cancelled')),
  freshness_state text NOT NULL DEFAULT 'current' CHECK (freshness_state IN ('current','stale')),
  stale_reasons jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(stale_reasons)='array'),
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(warnings)='array'),
  participant_count integer NOT NULL CHECK (participant_count BETWEEN 2 AND 50),
  completed_participant_count integer NOT NULL DEFAULT 0 CHECK (completed_participant_count >= 0),
  manifest_checksum char(64) NOT NULL CHECK (manifest_checksum ~ '^[0-9a-f]{64}$'),
  snapshot_checksum char(64) CHECK (snapshot_checksum IS NULL OR snapshot_checksum ~ '^[0-9a-f]{64}$'),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 240),
  initiated_by_external_user_id varchar(24) NOT NULL CHECK (initiated_by_external_user_id ~ '^[0-9a-f]{24}$'),
  correlation_id text NOT NULL CHECK (char_length(correlation_id) BETWEEN 1 AND 200),
  cancellation_requested_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,id),
  UNIQUE (organization_id,idempotency_key),
  UNIQUE (organization_id,manifest_checksum),
  FOREIGN KEY (organization_id,proposal_reference_id) REFERENCES rfpilot.proposal_references(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (requirement_set_id,organization_id) REFERENCES rfpilot.requirement_sets(id,organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (matrix_version_id,organization_id) REFERENCES rfpilot.evaluation_matrix_versions(id,organization_id) ON DELETE RESTRICT
);

CREATE TABLE rfpilot.comparison_manifests (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  comparison_run_id uuid NOT NULL UNIQUE,
  proposal_mongo_id varchar(24) NOT NULL CHECK (proposal_mongo_id ~ '^[0-9a-f]{24}$'),
  proposal_version text NOT NULL,
  proposal_checksum char(64) NOT NULL CHECK (proposal_checksum ~ '^[0-9a-f]{64}$'),
  requirement_set_version integer NOT NULL CHECK (requirement_set_version > 0),
  requirement_checksum char(64) NOT NULL CHECK (requirement_checksum ~ '^[0-9a-f]{64}$'),
  matrix_version integer NOT NULL CHECK (matrix_version > 0),
  matrix_checksum char(64) NOT NULL CHECK (matrix_checksum ~ '^[0-9a-f]{64}$'),
  price_visibility text NOT NULL CHECK (price_visibility IN ('reviewers','committee','hidden')),
  commercial_policy_version text NOT NULL,
  extraction_policy_version text NOT NULL,
  assessment_schema_version text NOT NULL,
  scoring_policy_version text NOT NULL,
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest)='object'),
  content_checksum char(64) NOT NULL CHECK (content_checksum ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,id),
  FOREIGN KEY (organization_id,comparison_run_id) REFERENCES rfpilot.comparison_runs(organization_id,id) ON DELETE RESTRICT
);

CREATE TABLE rfpilot.comparison_participants (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  comparison_run_id uuid NOT NULL,
  vendor_submission_mongo_id varchar(24) NOT NULL CHECK (vendor_submission_mongo_id ~ '^[0-9a-f]{24}$'),
  vendor_submission_version_mongo_id varchar(24) NOT NULL CHECK (vendor_submission_version_mongo_id ~ '^[0-9a-f]{24}$'),
  vendor_label text NOT NULL CHECK (char_length(vendor_label) BETWEEN 1 AND 255),
  submission_manifest_checksum char(64) NOT NULL CHECK (submission_manifest_checksum ~ '^[0-9a-f]{64}$'),
  intelligence_run_id uuid NOT NULL,
  evaluation_run_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  current_stage text NOT NULL DEFAULT 'snapshot' CHECK (current_stage IN ('snapshot','completed','failed','cancelled')),
  warning_count integer NOT NULL DEFAULT 0 CHECK (warning_count >= 0),
  safe_error_code text,
  output_checksum char(64) CHECK (output_checksum IS NULL OR output_checksum ~ '^[0-9a-f]{64}$'),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,id),
  UNIQUE (comparison_run_id,vendor_submission_mongo_id),
  UNIQUE (comparison_run_id,vendor_submission_version_mongo_id),
  UNIQUE (comparison_run_id,ordinal),
  FOREIGN KEY (organization_id,comparison_run_id) REFERENCES rfpilot.comparison_runs(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,intelligence_run_id) REFERENCES rfpilot.vendor_intelligence_runs(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,evaluation_run_id) REFERENCES rfpilot.vendor_evaluation_runs(organization_id,id) ON DELETE RESTRICT
);

CREATE TABLE rfpilot.comparison_job_nodes (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  comparison_run_id uuid NOT NULL,
  participant_id uuid,
  node_key text NOT NULL CHECK (char_length(node_key) BETWEEN 1 AND 200),
  job_type text NOT NULL CHECK (job_type IN ('comparison_participant_snapshot','comparison_aggregate')),
  ai_job_id uuid,
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','queued','running','retry_scheduled','succeeded','failed','cancelled','dead_letter')),
  weight numeric(6,3) NOT NULL CHECK (weight > 0 AND weight <= 100),
  mandatory boolean NOT NULL DEFAULT true,
  input_checksum char(64) NOT NULL CHECK (input_checksum ~ '^[0-9a-f]{64}$'),
  output_reference text,
  safe_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,id),
  UNIQUE (comparison_run_id,node_key),
  UNIQUE (ai_job_id),
  FOREIGN KEY (organization_id,comparison_run_id) REFERENCES rfpilot.comparison_runs(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,participant_id) REFERENCES rfpilot.comparison_participants(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,ai_job_id) REFERENCES rfpilot.ai_jobs(organization_id,id) ON DELETE RESTRICT
);

CREATE TABLE rfpilot.comparison_job_dependencies (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  comparison_run_id uuid NOT NULL,
  parent_node_id uuid NOT NULL,
  child_node_id uuid NOT NULL,
  required_status text NOT NULL DEFAULT 'succeeded' CHECK (required_status='succeeded'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (parent_node_id,child_node_id),
  CHECK (parent_node_id <> child_node_id),
  FOREIGN KEY (organization_id,comparison_run_id) REFERENCES rfpilot.comparison_runs(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,parent_node_id) REFERENCES rfpilot.comparison_job_nodes(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,child_node_id) REFERENCES rfpilot.comparison_job_nodes(organization_id,id) ON DELETE RESTRICT
);

CREATE TABLE rfpilot.comparison_participant_results (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  comparison_run_id uuid NOT NULL,
  participant_id uuid NOT NULL UNIQUE,
  schema_version text NOT NULL DEFAULT 'comparison-participant.v1',
  result jsonb NOT NULL CHECK (jsonb_typeof(result)='object'),
  content_checksum char(64) NOT NULL CHECK (content_checksum ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,id),
  FOREIGN KEY (organization_id,comparison_run_id) REFERENCES rfpilot.comparison_runs(organization_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,participant_id) REFERENCES rfpilot.comparison_participants(organization_id,id) ON DELETE RESTRICT
);

CREATE TABLE rfpilot.comparison_snapshots (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  comparison_run_id uuid NOT NULL UNIQUE,
  schema_version text NOT NULL DEFAULT 'proposal-intelligence-comparison.v1',
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
  content_checksum char(64) NOT NULL CHECK (content_checksum ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,id),
  FOREIGN KEY (organization_id,comparison_run_id) REFERENCES rfpilot.comparison_runs(organization_id,id) ON DELETE RESTRICT
);

CREATE TABLE rfpilot.comparison_operations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  comparison_run_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 240),
  manifest_checksum char(64) NOT NULL CHECK (manifest_checksum ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,id),
  UNIQUE (organization_id,idempotency_key),
  FOREIGN KEY (organization_id,comparison_run_id) REFERENCES rfpilot.comparison_runs(organization_id,id) ON DELETE RESTRICT
);

CREATE INDEX comparison_runs_proposal_idx ON rfpilot.comparison_runs (organization_id,proposal_reference_id,created_at DESC);
CREATE INDEX comparison_participants_run_idx ON rfpilot.comparison_participants (comparison_run_id,ordinal);
CREATE INDEX comparison_nodes_run_idx ON rfpilot.comparison_job_nodes (comparison_run_id,status,created_at);
CREATE INDEX comparison_dependencies_child_idx ON rfpilot.comparison_job_dependencies (child_node_id);

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['comparison_runs','comparison_manifests','comparison_participants','comparison_job_nodes','comparison_job_dependencies','comparison_participant_results','comparison_snapshots','comparison_operations'] LOOP
    EXECUTE format('ALTER TABLE rfpilot.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE rfpilot.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY tenant_%I ON rfpilot.%I USING (organization_id=rfpilot.current_organization_id()) WITH CHECK (organization_id=rfpilot.current_organization_id())',table_name,table_name);
  END LOOP;
END $$;

CREATE FUNCTION rfpilot.guard_comparison_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'comparison manifest and snapshot records are immutable'; END $$;
CREATE TRIGGER comparison_manifests_immutable BEFORE UPDATE OR DELETE ON rfpilot.comparison_manifests FOR EACH ROW EXECUTE FUNCTION rfpilot.guard_comparison_immutable();
CREATE TRIGGER comparison_dependencies_immutable BEFORE UPDATE OR DELETE ON rfpilot.comparison_job_dependencies FOR EACH ROW EXECUTE FUNCTION rfpilot.guard_comparison_immutable();
CREATE TRIGGER comparison_participant_results_immutable BEFORE UPDATE OR DELETE ON rfpilot.comparison_participant_results FOR EACH ROW EXECUTE FUNCTION rfpilot.guard_comparison_immutable();
CREATE TRIGGER comparison_snapshots_immutable BEFORE UPDATE OR DELETE ON rfpilot.comparison_snapshots FOR EACH ROW EXECUTE FUNCTION rfpilot.guard_comparison_immutable();
CREATE TRIGGER comparison_operations_immutable BEFORE UPDATE OR DELETE ON rfpilot.comparison_operations FOR EACH ROW EXECUTE FUNCTION rfpilot.guard_comparison_immutable();
