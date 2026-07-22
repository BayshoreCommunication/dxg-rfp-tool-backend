-- Companion to 023: the per-application item ordinal carried the same 25-item
-- assumption, so a selection larger than 25 failed on the items insert.
ALTER TABLE rfpilot.candidate_application_items DROP CONSTRAINT candidate_application_items_ordinal_check;
ALTER TABLE rfpilot.candidate_application_items ADD CONSTRAINT candidate_application_items_ordinal_check CHECK(ordinal BETWEEN 0 AND 199);
