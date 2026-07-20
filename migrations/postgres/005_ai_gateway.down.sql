DROP TRIGGER IF EXISTS ai_budget_ledger_no_mutation ON rfpilot.ai_budget_ledger;
DROP FUNCTION IF EXISTS rfpilot.reject_ai_ledger_mutation();
DROP TABLE IF EXISTS rfpilot.ai_test_requests,rfpilot.ai_budget_ledger,rfpilot.ai_budget_accounts,rfpilot.ai_validation_results,rfpilot.ai_run_attempts;
ALTER TABLE rfpilot.ai_runs DROP CONSTRAINT IF EXISTS ai_runs_policy_fk, DROP CONSTRAINT IF EXISTS ai_runs_prompt_fk, DROP CONSTRAINT IF EXISTS ai_runs_schema_fk;
DROP TABLE IF EXISTS rfpilot.ai_provider_policies,rfpilot.prompt_releases,rfpilot.output_schema_releases;
DROP INDEX IF EXISTS rfpilot.ai_runs_idempotency_idx;
ALTER TABLE rfpilot.ai_runs DROP CONSTRAINT ai_runs_status_check;
ALTER TABLE rfpilot.ai_runs DROP COLUMN operation,DROP COLUMN purpose,DROP COLUMN classification,DROP COLUMN policy_id,DROP COLUMN prompt_release_id,DROP COLUMN schema_release_id,DROP COLUMN idempotency_key,DROP COLUMN input_checksum,DROP COLUMN reserved_cost_micros,DROP COLUMN latency_ms,DROP COLUMN finish_reason,DROP COLUMN output;
ALTER TABLE rfpilot.ai_runs ADD CONSTRAINT ai_runs_status_check CHECK(status IN('started','succeeded','failed','cancelled'));
