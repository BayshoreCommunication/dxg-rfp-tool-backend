-- Automatic-application rows cannot survive a review_id NOT NULL restore.
DELETE FROM rfpilot.room_recommendation_applications WHERE review_id IS NULL;
ALTER TABLE rfpilot.room_recommendation_applications DROP CONSTRAINT room_recommendation_applications_selected_count_check;
ALTER TABLE rfpilot.room_recommendation_applications ADD CONSTRAINT room_recommendation_applications_selected_count_check CHECK (selected_count BETWEEN 1 AND 50);
ALTER TABLE rfpilot.room_recommendation_applications DROP COLUMN IF EXISTS skipped_paths;
ALTER TABLE rfpilot.room_recommendation_applications DROP COLUMN IF EXISTS automatic;
ALTER TABLE rfpilot.room_recommendation_applications ALTER COLUMN review_id SET NOT NULL;
