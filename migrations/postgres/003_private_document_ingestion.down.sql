DROP TRIGGER IF EXISTS document_source_transition ON rfpilot.document_sources;
DROP FUNCTION IF EXISTS rfpilot.enforce_document_source_transition();
DROP TABLE IF EXISTS rfpilot.document_scan_results;
DROP TABLE IF EXISTS rfpilot.document_objects;
DROP TABLE IF EXISTS rfpilot.document_sources;
