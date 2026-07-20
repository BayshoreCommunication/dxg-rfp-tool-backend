DROP TRIGGER IF EXISTS knowledge_fragments_no_mutation ON rfpilot.knowledge_source_fragments;
DROP FUNCTION IF EXISTS rfpilot.reject_knowledge_fragment_mutation();
DROP TABLE IF EXISTS rfpilot.knowledge_source_fragments;
DROP TABLE IF EXISTS rfpilot.knowledge_parser_runs;
DROP TABLE IF EXISTS rfpilot.knowledge_import_documents;
DROP TABLE IF EXISTS rfpilot.knowledge_import_batches;
