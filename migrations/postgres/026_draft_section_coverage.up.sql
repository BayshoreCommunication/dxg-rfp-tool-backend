-- The draft section enum dated from a generator that read only the event and
-- venueSchedule proposal sections, so there was no section for budget and
-- procurement dates, room-by-room requirements, venue technical needs, or
-- vendor submission terms — all of which a real AV RFP must contain. Widening
-- the Mongo projection is not enough on its own: both section-key CHECK
-- constraints from migration 018 have to admit the new keys, or a scoped
-- regeneration and every accept/reject decision on a new section would fail.
ALTER TABLE rfpilot.proposal_draft_runs
 DROP CONSTRAINT proposal_draft_runs_section_scope_check;
ALTER TABLE rfpilot.proposal_draft_runs
 ADD CONSTRAINT proposal_draft_runs_section_scope_check
 CHECK(section_scope IS NULL OR section_scope IN(
  'event_overview','objectives_audience','format_experience','venue_schedule',
  'production_scope','known_requirements','information_gaps',
  'budget_procurement','room_requirements','venue_technical','vendor_terms'));

ALTER TABLE rfpilot.proposal_draft_sections
 DROP CONSTRAINT proposal_draft_sections_key_check;
ALTER TABLE rfpilot.proposal_draft_sections
 ADD CONSTRAINT proposal_draft_sections_key_check
 CHECK(key IN(
  'event_overview','objectives_audience','format_experience','venue_schedule',
  'production_scope','known_requirements','information_gaps',
  'budget_procurement','room_requirements','venue_technical','vendor_terms'));

ALTER TABLE rfpilot.proposal_draft_section_decisions
 DROP CONSTRAINT proposal_draft_section_decisions_section_key_check;
ALTER TABLE rfpilot.proposal_draft_section_decisions
 ADD CONSTRAINT proposal_draft_section_decisions_section_key_check
 CHECK(section_key IN(
  'event_overview','objectives_audience','format_experience','venue_schedule',
  'production_scope','known_requirements','information_gaps',
  'budget_procurement','room_requirements','venue_technical','vendor_terms'));
