-- Typed conversation was stored as history and nothing else, so a planner who
-- described their whole event in chat recorded no structured data. Turns are
-- now batched into a transcript segment and materialised through the same
-- private-source boundary as a pasted note, which means a source can arrive
-- from three different places and the difference matters:
--
--   * upload       - the planner attached a file
--   * notes        - the planner explicitly pasted text as a source
--   * conversation - the system derived it from what they typed in chat
--
-- Only the third was created without a deliberate "this is a source" action, so
-- the UI has to label it honestly and the scan handler has to know whether to
-- chain extraction automatically. Existing rows are 'upload' or 'notes'; the
-- default keeps every historical row correct without a backfill.
ALTER TABLE rfpilot.document_sources
 ADD COLUMN origin text NOT NULL DEFAULT 'upload'
 CHECK (origin IN ('upload','notes','conversation'));

-- The conversation message that closed the segment. Nullable because only
-- conversation-derived sources have one, and UNIQUE because the segment
-- idempotency key is derived from exactly this message: a replayed request must
-- reuse the source rather than mint a second one for the same turns.
ALTER TABLE rfpilot.document_sources
 ADD COLUMN segment_message_id uuid REFERENCES rfpilot.conversation_messages(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX document_sources_segment_idx
 ON rfpilot.document_sources(segment_message_id) WHERE segment_message_id IS NOT NULL;

CREATE INDEX document_sources_origin_idx
 ON rfpilot.document_sources(organization_id, proposal_reference_id, origin);
