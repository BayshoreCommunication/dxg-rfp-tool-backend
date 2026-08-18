CREATE OR REPLACE FUNCTION rfpilot.guard_requirement_registry_child_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  frozen boolean;
BEGIN
  IF TG_TABLE_NAME = 'evaluation_criteria' THEN
    SELECT m.status <> 'draft'
      INTO frozen
      FROM rfpilot.evaluation_matrix_versions m
     WHERE m.id = OLD.matrix_version_id;
  ELSE
    SELECT s.status IN ('approved', 'superseded')
      INTO frozen
      FROM rfpilot.requirement_sets s
     WHERE s.id = OLD.requirement_set_id;
  END IF;

  IF coalesce(frozen, false) THEN
    RAISE EXCEPTION 'approved requirement registry records are immutable';
  END IF;
  RETURN OLD;
END
$$;
