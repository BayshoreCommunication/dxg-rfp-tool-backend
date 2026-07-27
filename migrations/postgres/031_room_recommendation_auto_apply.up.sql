-- Policy change (product decision, 2026-07-27): room recommendations now
-- apply automatically into EMPTY room fields — the planner adjusts values in
-- the form afterwards instead of approving each one first. Filled fields are
-- never overwritten, the allowlist still governs what may be written, and
-- every automatic application is recorded here with automatic=true.
-- Automatic applications have no review, so review_id becomes nullable and
-- the skipped targets are kept for transparency.
ALTER TABLE rfpilot.room_recommendation_applications ALTER COLUMN review_id DROP NOT NULL;
ALTER TABLE rfpilot.room_recommendation_applications ADD COLUMN automatic boolean NOT NULL DEFAULT false;
ALTER TABLE rfpilot.room_recommendation_applications ADD COLUMN skipped_paths jsonb NOT NULL DEFAULT '[]';
-- An automatic run may find every target already filled; that outcome is
-- still worth recording, so zero selections becomes legal.
ALTER TABLE rfpilot.room_recommendation_applications DROP CONSTRAINT room_recommendation_applications_selected_count_check;
ALTER TABLE rfpilot.room_recommendation_applications ADD CONSTRAINT room_recommendation_applications_selected_count_check CHECK (selected_count BETWEEN 0 AND 50);
