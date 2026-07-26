CREATE TABLE rfpilot.assistant_threads (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  owner_external_user_id varchar(24) NOT NULL CHECK (owner_external_user_id ~ '^[0-9a-f]{24}$'),
  title text NOT NULL DEFAULT 'New conversation' CHECK (char_length(trim(title)) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  message_count integer NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  idempotency_key text CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 1 AND 200),
  last_message_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);

CREATE UNIQUE INDEX assistant_threads_owner_idempotency_idx
  ON rfpilot.assistant_threads(organization_id, owner_external_user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX assistant_threads_owner_updated_idx
  ON rfpilot.assistant_threads(organization_id, owner_external_user_id, updated_at DESC, id DESC);

CREATE TABLE rfpilot.assistant_messages (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  thread_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 1),
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system_event')),
  content text NOT NULL DEFAULT '' CHECK (char_length(content) <= 64000),
  status text NOT NULL DEFAULT 'complete' CHECK (status IN ('pending', 'streaming', 'complete', 'failed', 'aborted')),
  idempotency_key text CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 1 AND 200),
  provider_response_id text CHECK (provider_response_id IS NULL OR char_length(provider_response_id) <= 200),
  model text CHECK (model IS NULL OR char_length(model) <= 200),
  input_tokens integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
  safe_error_code text CHECK (safe_error_code IS NULL OR char_length(safe_error_code) <= 100),
  citations jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(citations) = 'array'),
  actor_external_user_id varchar(24) CHECK (
    actor_external_user_id IS NULL OR actor_external_user_id ~ '^[0-9a-f]{24}$'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (thread_id, ordinal),
  FOREIGN KEY (organization_id, thread_id)
    REFERENCES rfpilot.assistant_threads(organization_id, id) ON DELETE RESTRICT,
  CHECK (role <> 'user' OR char_length(trim(content)) BETWEEN 1 AND 8000)
);

CREATE UNIQUE INDEX assistant_messages_idempotency_idx
  ON rfpilot.assistant_messages(thread_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX assistant_messages_thread_ordinal_idx
  ON rfpilot.assistant_messages(thread_id, ordinal);

ALTER TABLE rfpilot.assistant_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.assistant_threads FORCE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.assistant_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.assistant_messages FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_assistant_threads
  ON rfpilot.assistant_threads
  USING (organization_id = rfpilot.current_organization_id())
  WITH CHECK (organization_id = rfpilot.current_organization_id());
CREATE POLICY tenant_assistant_messages
  ON rfpilot.assistant_messages
  USING (organization_id = rfpilot.current_organization_id())
  WITH CHECK (organization_id = rfpilot.current_organization_id());

ALTER TABLE rfpilot.ai_provider_attempts
  DROP CONSTRAINT ai_provider_attempts_run_type_check;
ALTER TABLE rfpilot.ai_provider_attempts
  ADD CONSTRAINT ai_provider_attempts_run_type_check
  CHECK (run_type IN (
    'proposal_context',
    'proposal_draft',
    'conversation_chat',
    'vendor_response_analyze',
    'platform_assistant'
  ));
