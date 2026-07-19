ALTER TABLE rfpilot.ai_jobs DROP CONSTRAINT ai_jobs_status_check;
ALTER TABLE rfpilot.ai_jobs
  ADD COLUMN input_reference text,
  ADD COLUMN input_version text,
  ADD COLUMN input_checksum char(64) CHECK (input_checksum IS NULL OR input_checksum ~ '^[0-9a-f]{64}$'),
  ADD COLUMN priority smallint NOT NULL DEFAULT 0 CHECK (priority BETWEEN -20 AND 20),
  ADD COLUMN progress smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  ADD COLUMN progress_stage text,
  ADD COLUMN max_attempts smallint NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  ADD COLUMN cancellation_requested_at timestamptz,
  ADD COLUMN cancelled_by_external_user_id varchar(24) CHECK (cancelled_by_external_user_id IS NULL OR cancelled_by_external_user_id ~ '^[0-9a-f]{24}$'),
  ADD COLUMN correlation_id text,
  ADD COLUMN lease_owner text,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN result_reference text,
  ADD COLUMN initiator_external_user_id varchar(24) CHECK (initiator_external_user_id IS NULL OR initiator_external_user_id ~ '^[0-9a-f]{24}$');
ALTER TABLE rfpilot.ai_jobs ADD CONSTRAINT ai_jobs_status_check
  CHECK (status IN ('queued','running','retry_scheduled','succeeded','failed','cancelled','dead_letter'));

CREATE TABLE rfpilot.job_attempts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  job_id uuid NOT NULL REFERENCES rfpilot.ai_jobs(id) ON DELETE RESTRICT,
  attempt_number smallint NOT NULL CHECK (attempt_number > 0),
  worker_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('running','succeeded','retryable_failure','permanent_failure','cancelled','interrupted')),
  lease_expires_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  diagnostic_code text,
  retry_decision text CHECK (retry_decision IS NULL OR retry_decision IN ('retry','fail','dead_letter','cancel')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (job_id, attempt_number)
);

CREATE TABLE rfpilot.job_dead_letters (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  job_id uuid NOT NULL REFERENCES rfpilot.ai_jobs(id) ON DELETE RESTRICT,
  reason_code text NOT NULL,
  last_diagnostic_code text,
  operator_status text NOT NULL DEFAULT 'open' CHECK (operator_status IN ('open','requeued','resolved')),
  recovered_by_external_user_id varchar(24) CHECK (recovered_by_external_user_id IS NULL OR recovered_by_external_user_id ~ '^[0-9a-f]{24}$'),
  recovery_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  recovered_at timestamptz,
  UNIQUE (job_id, operator_status)
);

CREATE INDEX ai_jobs_queue_idx ON rfpilot.ai_jobs (organization_id,status,available_at,priority DESC,created_at);
CREATE INDEX ai_jobs_lease_idx ON rfpilot.ai_jobs (status,lease_expires_at) WHERE status='running';
CREATE INDEX job_attempts_job_idx ON rfpilot.job_attempts (organization_id,job_id,attempt_number DESC);
CREATE INDEX job_dead_letters_open_idx ON rfpilot.job_dead_letters (organization_id,created_at DESC) WHERE operator_status='open';

ALTER TABLE rfpilot.job_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.job_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.job_dead_letters ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.job_dead_letters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_job_attempts ON rfpilot.job_attempts USING (organization_id=rfpilot.current_organization_id()) WITH CHECK (organization_id=rfpilot.current_organization_id());
CREATE POLICY tenant_isolation_job_dead_letters ON rfpilot.job_dead_letters USING (organization_id=rfpilot.current_organization_id()) WITH CHECK (organization_id=rfpilot.current_organization_id());

CREATE FUNCTION rfpilot.enforce_ai_job_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status=NEW.status THEN RETURN NEW; END IF;
  IF (OLD.status='queued' AND NEW.status IN ('running','cancelled'))
    OR (OLD.status='running' AND NEW.status IN ('succeeded','failed','retry_scheduled','cancelled','dead_letter'))
    OR (OLD.status='retry_scheduled' AND NEW.status IN ('running','cancelled','dead_letter'))
    OR (OLD.status IN ('failed','dead_letter') AND NEW.status='queued') THEN RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid ai job transition: % -> %',OLD.status,NEW.status;
END $$;
CREATE TRIGGER ai_job_transition BEFORE UPDATE OF status ON rfpilot.ai_jobs FOR EACH ROW EXECUTE FUNCTION rfpilot.enforce_ai_job_transition();
