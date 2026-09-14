DELETE FROM rfpilot.extracted_fact_evidence
 WHERE evidence_fragment_id IN (
   SELECT id FROM rfpilot.evidence_fragments WHERE kind='structured_field'
 );
DELETE FROM rfpilot.requirement_evidence_mappings
 WHERE evidence_fragment_id IN (
   SELECT id FROM rfpilot.evidence_fragments WHERE kind='structured_field'
 );
DELETE FROM rfpilot.evidence_fragments WHERE kind='structured_field';
DELETE FROM rfpilot.source_extraction_runs WHERE source_kind='structured_response';

ALTER TABLE rfpilot.evidence_fragments
  DROP CONSTRAINT evidence_fragments_trust_class_check;
ALTER TABLE rfpilot.evidence_fragments
  ADD CONSTRAINT evidence_fragments_trust_class_check
  CHECK (trust_class='untrusted_vendor_content');

ALTER TABLE rfpilot.evidence_fragments
  DROP CONSTRAINT evidence_fragments_kind_check;
ALTER TABLE rfpilot.evidence_fragments
  ADD CONSTRAINT evidence_fragments_kind_check
  CHECK (kind IN ('paragraph','line','table_row','cover_message'));

ALTER TABLE rfpilot.source_extraction_runs
  DROP CONSTRAINT source_extraction_runs_source_kind_check;
ALTER TABLE rfpilot.source_extraction_runs
  ADD CONSTRAINT source_extraction_runs_source_kind_check
  CHECK (source_kind IN ('document','cover_message'));
