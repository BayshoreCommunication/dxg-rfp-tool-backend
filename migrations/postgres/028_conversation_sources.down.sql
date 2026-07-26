-- Conversation-derived sources cannot survive the rollback: without the origin
-- column they would be indistinguishable from files the planner deliberately
-- attached, and their extraction runs would keep citing them. They are
-- tombstoned rather than deleted so the audit trail still records that they
-- existed, matching how retention releases a source.
UPDATE rfpilot.document_sources
   SET deleted_at = COALESCE(deleted_at, now()), status = 'deleted', updated_at = now()
 WHERE origin = 'conversation' AND deleted_at IS NULL;

DROP INDEX IF EXISTS rfpilot.document_sources_origin_idx;
DROP INDEX IF EXISTS rfpilot.document_sources_segment_idx;

ALTER TABLE rfpilot.document_sources DROP COLUMN segment_message_id;
ALTER TABLE rfpilot.document_sources DROP COLUMN origin;
