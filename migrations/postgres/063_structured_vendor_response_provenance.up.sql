ALTER TABLE rfpilot.source_extraction_runs
  DROP CONSTRAINT source_extraction_runs_source_kind_check;
ALTER TABLE rfpilot.source_extraction_runs
  ADD CONSTRAINT source_extraction_runs_source_kind_check
  CHECK (source_kind IN ('document','cover_message','structured_response'));

ALTER TABLE rfpilot.evidence_fragments
  DROP CONSTRAINT evidence_fragments_kind_check;
ALTER TABLE rfpilot.evidence_fragments
  ADD CONSTRAINT evidence_fragments_kind_check
  CHECK (kind IN ('paragraph','line','table_row','cover_message','structured_field'));

ALTER TABLE rfpilot.evidence_fragments
  DROP CONSTRAINT evidence_fragments_trust_class_check;
ALTER TABLE rfpilot.evidence_fragments
  ADD CONSTRAINT evidence_fragments_trust_class_check
  CHECK (trust_class IN (
    'untrusted_vendor_content',
    'first_party_vendor_statement',
    'server_calculation'
  ));

