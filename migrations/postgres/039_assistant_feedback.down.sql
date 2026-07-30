DROP POLICY IF EXISTS tenant_assistant_feedback
  ON rfpilot.assistant_feedback;
DROP TABLE IF EXISTS rfpilot.assistant_feedback;

ALTER TABLE rfpilot.assistant_messages
  DROP CONSTRAINT IF EXISTS assistant_messages_organization_id_id_key,
  DROP CONSTRAINT IF EXISTS assistant_messages_completion_latency_ms_check,
  DROP CONSTRAINT IF EXISTS assistant_messages_first_token_ms_check,
  DROP CONSTRAINT IF EXISTS assistant_messages_knowledge_version_check,
  DROP CONSTRAINT IF EXISTS assistant_messages_prompt_version_check,
  DROP CONSTRAINT IF EXISTS assistant_messages_response_kind_check,
  DROP COLUMN IF EXISTS completion_latency_ms,
  DROP COLUMN IF EXISTS first_token_ms,
  DROP COLUMN IF EXISTS knowledge_version,
  DROP COLUMN IF EXISTS prompt_version,
  DROP COLUMN IF EXISTS response_kind;
