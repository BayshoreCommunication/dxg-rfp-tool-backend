DROP TRIGGER IF EXISTS ai_job_transition ON rfpilot.ai_jobs;
DROP FUNCTION IF EXISTS rfpilot.enforce_ai_job_transition();
DROP TABLE IF EXISTS rfpilot.job_dead_letters;
DROP TABLE IF EXISTS rfpilot.job_attempts;
DROP INDEX IF EXISTS rfpilot.ai_jobs_lease_idx;
DROP INDEX IF EXISTS rfpilot.ai_jobs_queue_idx;
ALTER TABLE rfpilot.ai_jobs DROP CONSTRAINT ai_jobs_status_check;
ALTER TABLE rfpilot.ai_jobs
  DROP COLUMN IF EXISTS input_reference,
  DROP COLUMN IF EXISTS input_version,
  DROP COLUMN IF EXISTS input_checksum,
  DROP COLUMN IF EXISTS priority,
  DROP COLUMN IF EXISTS progress,
  DROP COLUMN IF EXISTS progress_stage,
  DROP COLUMN IF EXISTS max_attempts,
  DROP COLUMN IF EXISTS cancellation_requested_at,
  DROP COLUMN IF EXISTS cancelled_by_external_user_id,
  DROP COLUMN IF EXISTS correlation_id,
  DROP COLUMN IF EXISTS lease_owner,
  DROP COLUMN IF EXISTS lease_expires_at,
  DROP COLUMN IF EXISTS result_reference,
  DROP COLUMN IF EXISTS initiator_external_user_id;
ALTER TABLE rfpilot.ai_jobs ADD CONSTRAINT ai_jobs_status_check CHECK (status IN ('queued','running','succeeded','failed','cancelled','dead_letter'));
