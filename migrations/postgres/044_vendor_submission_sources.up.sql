-- Register immutable vendor-submission documents in the governed source
-- boundary without attributing a public vendor upload to a planner account.
ALTER TABLE rfpilot.document_sources
  DROP CONSTRAINT document_sources_purpose_check;
ALTER TABLE rfpilot.document_sources
  ADD CONSTRAINT document_sources_purpose_check
  CHECK (purpose IN ('proposal_source','organization_knowledge','vendor_submission'));

ALTER TABLE rfpilot.document_sources
  ALTER COLUMN uploader_external_user_id DROP NOT NULL,
  ADD COLUMN vendor_submission_mongo_id varchar(24)
    CHECK (vendor_submission_mongo_id IS NULL OR vendor_submission_mongo_id ~ '^[0-9a-f]{24}$'),
  ADD COLUMN vendor_submission_version_mongo_id varchar(24)
    CHECK (vendor_submission_version_mongo_id IS NULL OR vendor_submission_version_mongo_id ~ '^[0-9a-f]{24}$'),
  ADD COLUMN vendor_document_id uuid;

CREATE UNIQUE INDEX document_sources_vendor_document_idx
  ON rfpilot.document_sources(organization_id, vendor_document_id)
  WHERE vendor_document_id IS NOT NULL;
CREATE INDEX document_sources_vendor_version_idx
  ON rfpilot.document_sources(organization_id, vendor_submission_version_mongo_id)
  WHERE vendor_submission_version_mongo_id IS NOT NULL;

ALTER TABLE rfpilot.document_scan_results
  DROP CONSTRAINT document_scan_results_status_check;
ALTER TABLE rfpilot.document_scan_results
  ADD CONSTRAINT document_scan_results_status_check
  CHECK (status IN ('clean','infected','error','unavailable','skipped'));
