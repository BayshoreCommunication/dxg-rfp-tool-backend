-- Rolling back narrows the section-key domain, so any data written under the
-- wider set must go first or the constraints cannot be re-added. Decisions on
-- the new sections are discarded and scoped runs are unscoped (a NULL
-- section_scope is a full-draft run, which is always valid). This is lossy by
-- necessity — draft prose itself is candidate intelligence, not proposal
-- content, so nothing authoritative is destroyed.
DELETE FROM rfpilot.proposal_draft_section_decisions
 WHERE section_key IN('budget_procurement','room_requirements','venue_technical','vendor_terms');

UPDATE rfpilot.proposal_draft_runs SET section_scope=NULL
 WHERE section_scope IN('budget_procurement','room_requirements','venue_technical','vendor_terms');

-- proposal_draft_sections cannot simply be deleted from. Migration 011 gives
-- sections, paragraphs, and citations BEFORE UPDATE OR DELETE triggers that
-- raise 'proposal draft results are immutable', and paragraphs/citations hold
-- NOT NULL foreign keys with no ON DELETE CASCADE. So the dependent rows must
-- go first, innermost outward, with the immutability guards suspended for the
-- duration of this rollback only.
ALTER TABLE rfpilot.proposal_draft_citations DISABLE TRIGGER draft_citations_immutable;
ALTER TABLE rfpilot.proposal_draft_paragraphs DISABLE TRIGGER draft_paragraphs_immutable;
ALTER TABLE rfpilot.proposal_draft_sections DISABLE TRIGGER draft_sections_immutable;

DELETE FROM rfpilot.proposal_draft_citations WHERE paragraph_id IN(
 SELECT p.id FROM rfpilot.proposal_draft_paragraphs p
 JOIN rfpilot.proposal_draft_sections s ON s.id=p.section_id
 WHERE s.key IN('budget_procurement','room_requirements','venue_technical','vendor_terms'));

DELETE FROM rfpilot.proposal_draft_paragraphs WHERE section_id IN(
 SELECT id FROM rfpilot.proposal_draft_sections
 WHERE key IN('budget_procurement','room_requirements','venue_technical','vendor_terms'));

DELETE FROM rfpilot.proposal_draft_sections
 WHERE key IN('budget_procurement','room_requirements','venue_technical','vendor_terms');

ALTER TABLE rfpilot.proposal_draft_sections ENABLE TRIGGER draft_sections_immutable;
ALTER TABLE rfpilot.proposal_draft_paragraphs ENABLE TRIGGER draft_paragraphs_immutable;
ALTER TABLE rfpilot.proposal_draft_citations ENABLE TRIGGER draft_citations_immutable;

ALTER TABLE rfpilot.proposal_draft_runs
 DROP CONSTRAINT proposal_draft_runs_section_scope_check;
ALTER TABLE rfpilot.proposal_draft_runs
 ADD CONSTRAINT proposal_draft_runs_section_scope_check
 CHECK(section_scope IS NULL OR section_scope IN(
  'event_overview','objectives_audience','format_experience','venue_schedule',
  'production_scope','known_requirements','information_gaps'));

ALTER TABLE rfpilot.proposal_draft_sections
 DROP CONSTRAINT proposal_draft_sections_key_check;
ALTER TABLE rfpilot.proposal_draft_sections
 ADD CONSTRAINT proposal_draft_sections_key_check
 CHECK(key IN(
  'event_overview','objectives_audience','format_experience','venue_schedule',
  'production_scope','known_requirements','information_gaps'));

ALTER TABLE rfpilot.proposal_draft_section_decisions
 DROP CONSTRAINT proposal_draft_section_decisions_section_key_check;
ALTER TABLE rfpilot.proposal_draft_section_decisions
 ADD CONSTRAINT proposal_draft_section_decisions_section_key_check
 CHECK(section_key IN(
  'event_overview','objectives_audience','format_experience','venue_schedule',
  'production_scope','known_requirements','information_gaps'));
