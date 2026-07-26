DROP INDEX IF EXISTS rfpilot.document_sources_retention_idx;
DROP INDEX IF EXISTS rfpilot.vendor_analysis_runs_retention_idx;
DROP INDEX IF EXISTS rfpilot.candidate_applications_retention_idx;
DROP INDEX IF EXISTS rfpilot.proposal_draft_runs_retention_idx;
DROP INDEX IF EXISTS rfpilot.proposal_context_runs_retention_idx;

-- Restore the wider immutability guard. Safe in either direction: it only ever
-- adds a restriction back.
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
