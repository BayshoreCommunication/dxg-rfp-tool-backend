ALTER TABLE rfpilot.ai_provider_attempts DROP CONSTRAINT ai_provider_attempts_run_type_check;
ALTER TABLE rfpilot.ai_provider_attempts ADD CONSTRAINT ai_provider_attempts_run_type_check CHECK(run_type IN('proposal_context','proposal_draft'));
