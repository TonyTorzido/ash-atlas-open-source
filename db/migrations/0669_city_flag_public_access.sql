-- City control replaces every personal access policy. City Seats and expansion
-- flags are public, free jump destinations regardless of their contributor's
-- prior access mode, enemies, passage grants, or Custom-group restrictions.

ALTER TABLE flags DROP CONSTRAINT IF EXISTS flags_access_scope_check;

CREATE OR REPLACE FUNCTION prepare_personal_flag_access_change() RETURNS trigger AS $$
BEGIN
  IF OLD.control_type IS DISTINCT FROM NEW.control_type
     OR (OLD.owner_id IS DISTINCT FROM NEW.owner_id AND OLD.access_mode = 'custom') THEN
    NEW.access_mode := CASE
      WHEN NEW.control_type IN ('city', 'city_seat') THEN 'public'
      ELSE 'private'
    END;
    NEW.jump_toll_gold := 0;
    NEW.custom_requests_enabled := false;
  END IF;
  IF OLD.owner_id IS DISTINCT FROM NEW.owner_id
     OR OLD.control_type IS DISTINCT FROM NEW.control_type
     OR OLD.access_mode IS DISTINCT FROM NEW.access_mode
     OR OLD.jump_toll_gold IS DISTINCT FROM NEW.jump_toll_gold THEN
    NEW.access_revision := OLD.access_revision + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE flags ADD CONSTRAINT flags_access_scope_check CHECK (
  control_type = 'personal'
  OR (
    control_type IN ('city', 'city_seat')
    AND access_mode = 'public'
    AND jump_toll_gold = 0
    AND custom_requests_enabled = false
  )
  OR (
    control_type IN ('kingdom', 'kingdom_seat')
    AND access_mode = 'private'
    AND jump_toll_gold = 0
    AND custom_requests_enabled = false
  )
) NOT VALID;

UPDATE flags
SET access_mode = 'public',
    jump_toll_gold = 0,
    custom_requests_enabled = false
WHERE control_type IN ('city', 'city_seat')
  AND (
    access_mode <> 'public'
    OR jump_toll_gold <> 0
    OR custom_requests_enabled
  );

DELETE FROM custom_flag_group_memberships membership
USING flags city_flag
WHERE membership.flag_id = city_flag.id
  AND city_flag.control_type IN ('city', 'city_seat');

UPDATE custom_flag_group_requests request
SET source_flag_id = NULL
FROM flags city_flag
WHERE request.source_flag_id = city_flag.id
  AND city_flag.control_type IN ('city', 'city_seat');

UPDATE normal_flag_passage_requests request
SET source_flag_id = NULL
FROM flags city_flag
WHERE request.source_flag_id = city_flag.id
  AND city_flag.control_type IN ('city', 'city_seat');

COMMENT ON CONSTRAINT flags_access_scope_check ON flags IS
  'Personal flags use owner policy, city controls are always public/free, and Kingdom controls remain private.';
