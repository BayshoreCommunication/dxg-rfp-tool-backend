DROP POLICY IF EXISTS tenant_assistant_legal_holds
  ON rfpilot.assistant_legal_holds;
DROP POLICY IF EXISTS tenant_assistant_deletion_requests
  ON rfpilot.assistant_deletion_requests;
DROP POLICY IF EXISTS tenant_assistant_retention_policies
  ON rfpilot.assistant_retention_policies;

DROP TABLE IF EXISTS rfpilot.assistant_legal_holds;
DROP TABLE IF EXISTS rfpilot.assistant_deletion_requests;
DROP TABLE IF EXISTS rfpilot.assistant_retention_policies;

DROP INDEX IF EXISTS rfpilot.assistant_threads_pending_purge_idx;
ALTER TABLE rfpilot.assistant_threads
  DROP CONSTRAINT IF EXISTS assistant_threads_deletion_window_check,
  DROP COLUMN IF EXISTS purge_after,
  DROP COLUMN IF EXISTS deleted_at;
