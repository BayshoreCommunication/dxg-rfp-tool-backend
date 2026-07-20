DROP TRIGGER IF EXISTS knowledge_release_fragments_immutable ON rfpilot.knowledge_release_fragments;
DROP FUNCTION IF EXISTS rfpilot.reject_release_manifest_mutation();
DROP TRIGGER IF EXISTS knowledge_review_submitted_immutable ON rfpilot.knowledge_review_versions;
DROP FUNCTION IF EXISTS rfpilot.reject_submitted_review_mutation();
DROP TABLE IF EXISTS rfpilot.knowledge_release_events;
DROP TABLE IF EXISTS rfpilot.knowledge_release_fragments;
DROP TABLE IF EXISTS rfpilot.knowledge_releases;
DROP TABLE IF EXISTS rfpilot.knowledge_approval_decisions;
DROP TABLE IF EXISTS rfpilot.knowledge_fragment_decisions;
DROP TABLE IF EXISTS rfpilot.knowledge_review_versions;
ALTER TABLE rfpilot.knowledge_import_batches DROP CONSTRAINT knowledge_import_batches_status_check;
ALTER TABLE rfpilot.knowledge_import_batches ADD CONSTRAINT knowledge_import_batches_status_check
  CHECK(status IN('draft','uploading','scanning','parse_queued','parsing','needs_review','failed','blocked','archived'));
