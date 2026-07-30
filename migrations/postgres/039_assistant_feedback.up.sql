ALTER TABLE rfpilot.assistant_messages
  ADD COLUMN response_kind text,
  ADD COLUMN prompt_version text,
  ADD COLUMN knowledge_version text,
  ADD COLUMN first_token_ms integer,
  ADD COLUMN completion_latency_ms integer;

ALTER TABLE rfpilot.assistant_messages
  ADD CONSTRAINT assistant_messages_response_kind_check
  CHECK (
    response_kind IS NULL OR
    response_kind IN ('answer', 'clarification', 'refusal', 'abstention')
  ),
  ADD CONSTRAINT assistant_messages_prompt_version_check
  CHECK (
    prompt_version IS NULL OR
    char_length(prompt_version) BETWEEN 1 AND 100
  ),
  ADD CONSTRAINT assistant_messages_knowledge_version_check
  CHECK (
    knowledge_version IS NULL OR
    char_length(knowledge_version) BETWEEN 1 AND 100
  ),
  ADD CONSTRAINT assistant_messages_first_token_ms_check
  CHECK (first_token_ms IS NULL OR first_token_ms BETWEEN 0 AND 3600000),
  ADD CONSTRAINT assistant_messages_completion_latency_ms_check
  CHECK (
    completion_latency_ms IS NULL OR
    completion_latency_ms BETWEEN 0 AND 3600000
  ),
  ADD CONSTRAINT assistant_messages_organization_id_id_key
  UNIQUE (organization_id, id);

CREATE TABLE rfpilot.assistant_feedback (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL
    REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  thread_id uuid NOT NULL,
  message_id uuid NOT NULL,
  actor_external_user_id varchar(24) NOT NULL
    CHECK (actor_external_user_id ~ '^[0-9a-f]{24}$'),
  feedback_value text NOT NULL
    CHECK (feedback_value IN ('helpful', 'not_helpful')),
  feedback_reason text
    CHECK (
      feedback_reason IS NULL OR feedback_reason IN (
        'incorrect',
        'outdated',
        'did_not_understand',
        'missing_steps',
        'irrelevant',
        'other'
      )
    ),
  intent text,
  response_kind text NOT NULL
    CHECK (
      response_kind IN (
        'answer',
        'clarification',
        'refusal',
        'abstention',
        'legacy_unclassified'
      )
    ),
  model text,
  prompt_version text,
  knowledge_version text,
  rule_version text,
  pricing_version text,
  cited_source_ids text[] NOT NULL DEFAULT ARRAY[]::text[]
    CHECK (cardinality(cited_source_ids) <= 12),
  first_token_ms integer
    CHECK (first_token_ms IS NULL OR first_token_ms BETWEEN 0 AND 3600000),
  completion_latency_ms integer
    CHECK (
      completion_latency_ms IS NULL OR
      completion_latency_ms BETWEEN 0 AND 3600000
    ),
  idempotency_key text NOT NULL
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  input_checksum char(64) NOT NULL
    CHECK (input_checksum ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, thread_id)
    REFERENCES rfpilot.assistant_threads(organization_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, message_id)
    REFERENCES rfpilot.assistant_messages(organization_id, id)
    ON DELETE RESTRICT,
  UNIQUE (organization_id, actor_external_user_id, message_id),
  UNIQUE (organization_id, actor_external_user_id, idempotency_key),
  CHECK (
    feedback_value = 'not_helpful' OR feedback_reason IS NULL
  )
);

CREATE INDEX assistant_feedback_created_idx
  ON rfpilot.assistant_feedback(organization_id, created_at DESC);
CREATE INDEX assistant_feedback_quality_idx
  ON rfpilot.assistant_feedback(
    organization_id,
    intent,
    feedback_value,
    created_at DESC
  );

ALTER TABLE rfpilot.assistant_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.assistant_feedback FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_assistant_feedback
  ON rfpilot.assistant_feedback
  USING (organization_id = rfpilot.current_organization_id())
  WITH CHECK (organization_id = rfpilot.current_organization_id());
