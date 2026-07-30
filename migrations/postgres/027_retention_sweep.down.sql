DROP INDEX IF EXISTS rfpilot.document_sources_retention_idx;
DROP INDEX IF EXISTS rfpilot.vendor_analysis_runs_retention_idx;
DROP INDEX IF EXISTS rfpilot.candidate_applications_retention_idx;
DROP INDEX IF EXISTS rfpilot.proposal_draft_runs_retention_idx;
DROP INDEX IF EXISTS rfpilot.proposal_context_runs_retention_idx;

-- Restore the wider immutability guard. Safe in either direction: it only ever
-- adds a restriction back.
DROP TRIGGER candidate_application_items_immutable ON rfpilot.candidate_application_items;
CREATE TRIGGER candidate_application_items_immutable BEFORE UPDATE OR DELETE ON rfpilot.candidate_application_items
 FOR EACH ROW EXECUTE FUNCTION rfpilot.reject_candidate_application_evidence_mutation();

DROP TRIGGER proposal_context_issues_immutable ON rfpilot.proposal_context_issues;
CREATE TRIGGER proposal_context_issues_immutable BEFORE UPDATE OR DELETE ON rfpilot.proposal_context_issues
 FOR EACH ROW EXECUTE FUNCTION rfpilot.reject_proposal_context_result_mutation();

DROP TRIGGER proposal_context_operations_immutable ON rfpilot.proposal_context_operations;
CREATE TRIGGER proposal_context_operations_immutable BEFORE UPDATE OR DELETE ON rfpilot.proposal_context_operations
 FOR EACH ROW EXECUTE FUNCTION rfpilot.reject_proposal_context_result_mutation();

DROP TRIGGER proposal_context_evidence_immutable ON rfpilot.proposal_context_evidence;
CREATE TRIGGER proposal_context_evidence_immutable BEFORE UPDATE OR DELETE ON rfpilot.proposal_context_evidence
 FOR EACH ROW EXECUTE FUNCTION rfpilot.reject_proposal_context_result_mutation();
DROP TRIGGER draft_gaps_immutable ON rfpilot.proposal_draft_gaps;
CREATE TRIGGER draft_gaps_immutable BEFORE UPDATE OR DELETE ON rfpilot.proposal_draft_gaps
 FOR EACH ROW EXECUTE FUNCTION rfpilot.reject_proposal_draft_result_mutation();

DROP TRIGGER draft_citations_immutable ON rfpilot.proposal_draft_citations;
CREATE TRIGGER draft_citations_immutable BEFORE UPDATE OR DELETE ON rfpilot.proposal_draft_citations
 FOR EACH ROW EXECUTE FUNCTION rfpilot.reject_proposal_draft_result_mutation();

DROP TRIGGER draft_paragraphs_immutable ON rfpilot.proposal_draft_paragraphs;
CREATE TRIGGER draft_paragraphs_immutable BEFORE UPDATE OR DELETE ON rfpilot.proposal_draft_paragraphs
 FOR EACH ROW EXECUTE FUNCTION rfpilot.reject_proposal_draft_result_mutation();

DROP TRIGGER draft_sections_immutable ON rfpilot.proposal_draft_sections;
CREATE TRIGGER draft_sections_immutable BEFORE UPDATE OR DELETE ON rfpilot.proposal_draft_sections
 FOR EACH ROW EXECUTE FUNCTION rfpilot.reject_proposal_draft_result_mutation();
