ALTER TABLE rfpilot.assistant_messages
  ADD COLUMN intent text,
  ADD COLUMN intent_version text,
  ADD COLUMN intent_source text,
  ADD COLUMN intent_confidence text;

ALTER TABLE rfpilot.assistant_messages
  ADD CONSTRAINT assistant_messages_intent_check
  CHECK (
    intent IS NULL OR intent IN (
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
    )
  ),
  ADD CONSTRAINT assistant_messages_intent_version_check
  CHECK (
    intent_version IS NULL OR char_length(intent_version) BETWEEN 1 AND 100
  ),
  ADD CONSTRAINT assistant_messages_intent_source_check
  CHECK (
    intent_source IS NULL OR intent_source IN (
      'deterministic',
      'ui_context',
      'follow_up',
      'fallback'
    )
  ),
  ADD CONSTRAINT assistant_messages_intent_confidence_check
  CHECK (
    intent_confidence IS NULL OR intent_confidence IN ('high', 'medium', 'low')
  ),
  ADD CONSTRAINT assistant_messages_intent_metadata_complete_check
  CHECK (
    (intent IS NULL AND intent_version IS NULL AND intent_source IS NULL AND intent_confidence IS NULL)
    OR
    (intent IS NOT NULL AND intent_version IS NOT NULL AND intent_source IS NOT NULL AND intent_confidence IS NOT NULL)
  );

CREATE INDEX assistant_messages_intent_created_idx
  ON rfpilot.assistant_messages(organization_id, intent, created_at DESC)
  WHERE role = 'assistant' AND intent IS NOT NULL;
