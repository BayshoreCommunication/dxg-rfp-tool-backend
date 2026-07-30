CREATE TABLE rfpilot.assistant_product_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL
    REFERENCES rfpilot.organizations(id) ON DELETE RESTRICT,
  actor_pseudonym char(16) NOT NULL
    CHECK (actor_pseudonym ~ '^[0-9a-f]{16}$'),
  session_key char(32) NOT NULL
    CHECK (session_key ~ '^[0-9a-f]{32}$'),
  event_schema_version text NOT NULL
    CHECK (event_schema_version = 'assistant-product-event.v1'),
  event_type text NOT NULL
    CHECK (event_type IN (
      'assistant_opened',
      'suggestion_shown',
      'suggestion_selected',
      'message_submitted',
      'first_token_received',
      'response_completed',
      'response_failed',
      'response_retried',
      'citation_opened',
      'internal_route_opened',
      'feedback_submitted',
      'proposal_handoff_started',
      'proposal_handoff_completed',
      'analysis_started',
      'analysis_completed',
      'finding_reviewed',
      'field_change_proposed',
      'field_change_applied'
    )),
  organization_cohort text NOT NULL
    CHECK (char_length(organization_cohort) BETWEEN 1 AND 60),
  route_category text
    CHECK (route_category IS NULL OR route_category IN (
      'dashboard',
      'proposals',
      'proposal_creation',
      'proposal_detail',
      'proposal_assistant',
      'email',
      'vendor_responses',
      'settings',
      'other'
    )),
  intent text
    CHECK (intent IS NULL OR intent IN (
      'greeting_or_thanks',
      'platform_navigation',
      'proposal_creation',
      'proposal_review',
      'pre_send_checklist',
      'event_planning',
      'form_field_help',
      'proposal_specific_request',
      'equipment_scope_review',
      'budget_estimation',
      'historical_reference_request',
      'action_request',
      'unsupported_or_off_topic',
      'ambiguous'
    )),
  response_kind text
    CHECK (response_kind IS NULL OR response_kind IN (
      'answer',
      'clarification',
      'refusal',
      'abstention'
    )),
  model text CHECK (model IS NULL OR char_length(model) BETWEEN 1 AND 100),
  prompt_version text
    CHECK (prompt_version IS NULL OR char_length(prompt_version) BETWEEN 1 AND 100),
  knowledge_version text
    CHECK (knowledge_version IS NULL OR char_length(knowledge_version) BETWEEN 1 AND 100),
  rule_version text
    CHECK (rule_version IS NULL OR char_length(rule_version) BETWEEN 1 AND 100),
  pricing_version text
    CHECK (pricing_version IS NULL OR char_length(pricing_version) BETWEEN 1 AND 100),
  cited boolean,
  latency_bucket text
    CHECK (latency_bucket IS NULL OR latency_bucket IN (
      'under_250_ms',
      '250_to_999_ms',
      '1_to_2_99_s',
      '3_to_9_99_s',
      '10_s_or_more',
      'unknown'
    )),
  first_token_ms integer
    CHECK (first_token_ms IS NULL OR first_token_ms BETWEEN 0 AND 3600000),
  completion_latency_ms integer
    CHECK (
      completion_latency_ms IS NULL OR
      completion_latency_ms BETWEEN 0 AND 3600000
    ),
  input_tokens integer
    CHECK (input_tokens IS NULL OR input_tokens BETWEEN 0 AND 10000000),
  output_tokens integer
    CHECK (output_tokens IS NULL OR output_tokens BETWEEN 0 AND 10000000),
  estimated_cost_micros bigint
    CHECK (
      estimated_cost_micros IS NULL OR
      estimated_cost_micros BETWEEN 0 AND 100000000000
    ),
  error_category text
    CHECK (error_category IS NULL OR error_category IN (
      'authentication',
      'authorization',
      'rate_limit',
      'provider',
      'validation',
      'knowledge',
      'network',
      'user_abort',
      'internal',
      'none'
    )),
  finding_category text
    CHECK (finding_category IS NULL OR finding_category IN (
      'completeness',
      'schedule',
      'production',
      'budget',
      'risk',
      'scope',
      'room',
      'application',
      'other'
    )),
  completion_outcome text
    CHECK (completion_outcome IS NULL OR completion_outcome IN (
      'completed',
      'failed',
      'aborted',
      'retried',
      'navigated',
      'selected',
      'shown',
      'opened'
    )),
  feedback_value text
    CHECK (feedback_value IS NULL OR feedback_value IN (
      'helpful',
      'not_helpful'
    )),
  feedback_reason text
    CHECK (feedback_reason IS NULL OR feedback_reason IN (
      'incorrect',
      'outdated',
      'did_not_understand',
      'missing_steps',
      'irrelevant',
      'other'
    )),
  idempotency_key text NOT NULL
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  input_checksum char(64) NOT NULL
    CHECK (input_checksum ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, actor_pseudonym, idempotency_key),
  CHECK (feedback_value = 'not_helpful' OR feedback_reason IS NULL)
);

CREATE INDEX assistant_product_events_session_idx
  ON rfpilot.assistant_product_events(
    organization_id,
    session_key,
    occurred_at,
    id
  );
CREATE INDEX assistant_product_events_quality_idx
  ON rfpilot.assistant_product_events(
    organization_id,
    event_type,
    intent,
    occurred_at DESC
  );
CREATE INDEX assistant_product_events_versions_idx
  ON rfpilot.assistant_product_events(
    organization_id,
    prompt_version,
    knowledge_version,
    occurred_at DESC
  );

ALTER TABLE rfpilot.assistant_product_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfpilot.assistant_product_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_assistant_product_events
  ON rfpilot.assistant_product_events
  USING (organization_id = rfpilot.current_organization_id())
  WITH CHECK (organization_id = rfpilot.current_organization_id());
