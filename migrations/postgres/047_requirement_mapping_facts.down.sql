DROP TRIGGER IF EXISTS human_review_events_immutable ON rfpilot.human_review_events;
DROP TRIGGER IF EXISTS fact_validation_results_immutable ON rfpilot.fact_validation_results;
DROP TRIGGER IF EXISTS extracted_fact_evidence_immutable ON rfpilot.extracted_fact_evidence;
DROP TRIGGER IF EXISTS extracted_facts_immutable ON rfpilot.extracted_facts;
DROP TRIGGER IF EXISTS requirement_evidence_mappings_immutable ON rfpilot.requirement_evidence_mappings;
DROP FUNCTION IF EXISTS rfpilot.guard_vendor_intelligence_output_update();
DROP TABLE IF EXISTS rfpilot.human_review_events;
DROP TABLE IF EXISTS rfpilot.fact_validation_results;
DROP TABLE IF EXISTS rfpilot.extracted_fact_evidence;
DROP TABLE IF EXISTS rfpilot.extracted_facts;
DROP TABLE IF EXISTS rfpilot.requirement_evidence_mappings;
DROP TABLE IF EXISTS rfpilot.vendor_intelligence_runs;
DROP INDEX IF EXISTS rfpilot.evidence_fragments_org_id_uq;
DELETE FROM rfpilot.ai_provider_attempts WHERE run_type='vendor_requirement_facts';
ALTER TABLE rfpilot.ai_provider_attempts DROP CONSTRAINT ai_provider_attempts_run_type_check;
ALTER TABLE rfpilot.ai_provider_attempts ADD CONSTRAINT ai_provider_attempts_run_type_check
  CHECK (run_type IN ('proposal_context','proposal_draft','conversation_chat','vendor_response_analyze','platform_assistant'));
