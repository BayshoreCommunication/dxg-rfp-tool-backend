DROP INDEX IF EXISTS rfpilot.assistant_messages_intent_created_idx;

ALTER TABLE rfpilot.assistant_messages
  DROP CONSTRAINT IF EXISTS assistant_messages_intent_metadata_complete_check,
  DROP CONSTRAINT IF EXISTS assistant_messages_intent_confidence_check,
  DROP CONSTRAINT IF EXISTS assistant_messages_intent_source_check,
  DROP CONSTRAINT IF EXISTS assistant_messages_intent_version_check,
  DROP CONSTRAINT IF EXISTS assistant_messages_intent_check,
  DROP COLUMN IF EXISTS intent_confidence,
  DROP COLUMN IF EXISTS intent_source,
  DROP COLUMN IF EXISTS intent_version,
  DROP COLUMN IF EXISTS intent;
