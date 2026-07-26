-- Draft results carry BEFORE UPDATE OR DELETE immutability triggers so a
-- generated draft can never be rewritten to say something the model did not
-- produce. That invariant is about tampering, and it also made the rows
-- undeletable — so retention_until was written on every run and then never
-- enforced by anything, leaving expired AI evidence and draft prose in the
-- database and in backups indefinitely.
--
-- The triggers are narrowed to UPDATE. Immutability of content is preserved
-- exactly: no row can still be edited. Deletion remains impossible through the
-- API — there is no draft delete endpoint, and RLS still applies — but the
-- governed retention sweeper can now expire what it is supposed to expire.
DROP TRIGGER draft_sections_immutable ON rfpilot.proposal_draft_sections;
CREATE TRIGGER draft_sections_immutable BEFORE UPDATE ON rfpilot.proposal_draft_sections
 FOR EACH ROW EXECUTE FUNCTION rfpilot.reject_proposal_draft_result_mutation();

DROP TRIGGER draft_paragraphs_immutable ON rfpilot.proposal_draft_paragraphs;
CREATE TRIGGER draft_paragraphs_immutable BEFORE UPDATE ON rfpilot.proposal_draft_paragraphs
 FOR EACH ROW EXECUTE FUNCTION rfpilot.reject_proposal_draft_result_mutation();

DROP TRIGGER draft_citations_immutable ON rfpilot.proposal_draft_citations;
CREATE TRIGGER draft_citations_immutable BEFORE UPDATE ON rfpilot.proposal_draft_citations
 FOR EACH ROW EXECUTE FUNCTION rfpilot.reject_proposal_draft_result_mutation();

DROP TRIGGER draft_gaps_immutable ON rfpilot.proposal_draft_gaps;
CREATE TRIGGER draft_gaps_immutable BEFORE UPDATE ON rfpilot.proposal_draft_gaps
 FOR EACH ROW EXECUTE FUNCTION rfpilot.reject_proposal_draft_result_mutation();

-- The same guard sits on context-run results and candidate application items,
-- which the sweeper also has to expire. Narrowed on identical reasoning: these
-- rows must never be rewritten, but they must be removable when their retention
-- window closes. Missing these would have failed the sweep on its first pass
-- over any context run.
DROP TRIGGER proposal_context_evidence_immutable ON rfpilot.proposal_context_evidence;
CREATE TRIGGER proposal_context_evidence_immutable BEFORE UPDATE ON rfpilot.proposal_context_evidence
 FOR EACH ROW EXECUTE FUNCTION rfpilot.reject_proposal_context_result_mutation();

DROP TRIGGER proposal_context_operations_immutable ON rfpilot.proposal_context_operations;
CREATE TRIGGER proposal_context_operations_immutable BEFORE UPDATE ON rfpilot.proposal_context_operations
 FOR EACH ROW EXECUTE FUNCTION rfpilot.reject_proposal_context_result_mutation();

DROP TRIGGER proposal_context_issues_immutable ON rfpilot.proposal_context_issues;
CREATE TRIGGER proposal_context_issues_immutable BEFORE UPDATE ON rfpilot.proposal_context_issues
 FOR EACH ROW EXECUTE FUNCTION rfpilot.reject_proposal_context_result_mutation();

DROP TRIGGER candidate_application_items_immutable ON rfpilot.candidate_application_items;
CREATE TRIGGER candidate_application_items_immutable BEFORE UPDATE ON rfpilot.candidate_application_items
 FOR EACH ROW EXECUTE FUNCTION rfpilot.reject_candidate_application_evidence_mutation();

-- The sweeper deletes by expiry within a tenant, so every retention-owning
-- table needs an index on that predicate. Without these each pass is a full
-- scan of the family.
CREATE INDEX IF NOT EXISTS proposal_context_runs_retention_idx
 ON rfpilot.proposal_context_runs(organization_id, retention_until);
CREATE INDEX IF NOT EXISTS proposal_draft_runs_retention_idx
 ON rfpilot.proposal_draft_runs(organization_id, retention_until);
CREATE INDEX IF NOT EXISTS candidate_applications_retention_idx
 ON rfpilot.candidate_applications(organization_id, retention_until);
CREATE INDEX IF NOT EXISTS vendor_analysis_runs_retention_idx
 ON rfpilot.vendor_analysis_runs(organization_id, retention_until);
CREATE INDEX IF NOT EXISTS document_sources_retention_idx
 ON rfpilot.document_sources(organization_id, retention_until) WHERE deleted_at IS NULL;
