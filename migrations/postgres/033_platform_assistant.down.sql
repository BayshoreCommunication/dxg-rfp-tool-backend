DELETE FROM rfpilot.ai_provider_attempts WHERE run_type = 'platform_assistant';
ALTER TABLE rfpilot.ai_provider_attempts
  DROP CONSTRAINT ai_provider_attempts_run_type_check;
ALTER TABLE rfpilot.ai_provider_attempts
  ADD CONSTRAINT ai_provider_attempts_run_type_check
  CHECK (run_type IN (
    'proposal_context',
    'proposal_draft',
    'conversation_chat',
    'vendor_response_analyze'
  ));

DROP TABLE IF EXISTS rfpilot.assistant_messages;
DROP TABLE IF EXISTS rfpilot.assistant_threads;
