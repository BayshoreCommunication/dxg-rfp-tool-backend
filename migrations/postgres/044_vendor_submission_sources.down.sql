DELETE FROM rfpilot.document_scan_results
 WHERE object_id IN (
   SELECT o.id
     FROM rfpilot.document_objects o
     JOIN rfpilot.document_sources s ON s.id=o.source_id
    WHERE s.purpose='vendor_submission'
 );
DELETE FROM rfpilot.document_objects
 WHERE source_id IN (
   SELECT id FROM rfpilot.document_sources WHERE purpose='vendor_submission'
 );
DELETE FROM rfpilot.document_sources WHERE purpose='vendor_submission';

DROP INDEX IF EXISTS rfpilot.document_sources_vendor_version_idx;
DROP INDEX IF EXISTS rfpilot.document_sources_vendor_document_idx;

ALTER TABLE rfpilot.document_sources
  DROP COLUMN vendor_document_id,
  DROP COLUMN vendor_submission_version_mongo_id,
  DROP COLUMN vendor_submission_mongo_id,
  ALTER COLUMN uploader_external_user_id SET NOT NULL;

ALTER TABLE rfpilot.document_sources
  DROP CONSTRAINT document_sources_purpose_check;
ALTER TABLE rfpilot.document_sources
  ADD CONSTRAINT document_sources_purpose_check
  CHECK (purpose IN ('proposal_source','organization_knowledge'));

ALTER TABLE rfpilot.document_scan_results
  DROP CONSTRAINT document_scan_results_status_check;
ALTER TABLE rfpilot.document_scan_results
  ADD CONSTRAINT document_scan_results_status_check
  CHECK (status IN ('clean','infected','error','unavailable'));
