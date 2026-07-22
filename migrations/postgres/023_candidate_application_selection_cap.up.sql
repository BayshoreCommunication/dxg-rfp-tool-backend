-- The 25-item selection cap dated from the four-field Slice 2E whitelist. The
-- canonical mapping now approves 112 paths and a single extraction routinely
-- fills 40-60 of them, so one review must be applicable in one action.
ALTER TABLE rfpilot.candidate_applications DROP CONSTRAINT candidate_applications_selected_count_check;
ALTER TABLE rfpilot.candidate_applications ADD CONSTRAINT candidate_applications_selected_count_check CHECK(selected_count BETWEEN 1 AND 200);
