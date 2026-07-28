ALTER TABLE rfpilot.conversation_messages
  ADD COLUMN actions jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (
    jsonb_typeof(actions) = 'array'
    AND jsonb_array_length(actions) <= 2
    AND actions <@ '["download_room_schedule_template","open_room_specifications"]'::jsonb
  );
