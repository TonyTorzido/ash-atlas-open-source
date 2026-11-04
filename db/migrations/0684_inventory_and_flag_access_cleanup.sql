-- Enforce the canonical resource stack limits used by the server. Existing
-- oversized slot rows are repaired lazily by InventoryService while holding
-- the player's inventory lock, so no quantity is discarded when a grid is full.
UPDATE item_definitions
SET max_stack = limits.max_stack
FROM (
  VALUES
    ('wood'::text, 250),
    ('stone'::text, 250),
    ('food'::text, 100),
    ('ore'::text, 250),
    ('water'::text, 100),
    ('leather'::text, 250),
    ('balsam_resin'::text, 50)
) AS limits(item_id, max_stack)
WHERE item_definitions.item_id = limits.item_id
  AND item_definitions.max_stack IS DISTINCT FROM limits.max_stack;

-- Custom access is retired. Preserve access by converting existing Custom
-- flags/defaults/command records to Normal before constraining new writes.
ALTER TABLE flags DISABLE TRIGGER USER;
ALTER TABLE player_flag_preferences DISABLE TRIGGER USER;
ALTER TABLE custom_flag_group_requests DISABLE TRIGGER USER;
ALTER TABLE custom_flag_group_overrides DISABLE TRIGGER USER;
ALTER TABLE custom_flag_group_memberships DISABLE TRIGGER USER;
ALTER TABLE custom_flag_access_groups DISABLE TRIGGER USER;

UPDATE flags
SET access_mode = 'normal',
    jump_toll_gold = 0,
    custom_requests_enabled = false,
    access_revision = access_revision + 1
WHERE access_mode = 'custom';

UPDATE player_flag_preferences
SET default_flag_access_mode = 'normal',
    default_custom_group_id = NULL
WHERE default_flag_access_mode = 'custom'
   OR default_custom_group_id IS NOT NULL;

UPDATE flag_travel_commands
SET access_mode = 'normal',
    custom_group_id = NULL
WHERE access_mode = 'custom'
   OR custom_group_id IS NOT NULL;

DELETE FROM custom_flag_group_requests;
DELETE FROM custom_flag_group_overrides;
DELETE FROM custom_flag_group_memberships;
DELETE FROM custom_flag_access_groups;

ALTER TABLE flags DROP CONSTRAINT IF EXISTS flags_access_mode_check;
ALTER TABLE flags DROP CONSTRAINT IF EXISTS flags_access_scope_check;
ALTER TABLE flags ADD CONSTRAINT flags_access_mode_check
  CHECK (access_mode IN ('private', 'public', 'normal'));

ALTER TABLE player_flag_preferences
  DROP CONSTRAINT IF EXISTS player_flag_preferences_default_flag_access_mode_check;
ALTER TABLE player_flag_preferences
  ADD CONSTRAINT player_flag_preferences_default_flag_access_mode_check
  CHECK (default_flag_access_mode IN ('private', 'public', 'normal'));

ALTER TABLE flag_travel_commands
  DROP CONSTRAINT IF EXISTS flag_travel_commands_access_mode_check;
ALTER TABLE flag_travel_commands
  ADD CONSTRAINT flag_travel_commands_access_mode_check
  CHECK (access_mode IN ('private', 'public', 'normal'));

DROP TRIGGER IF EXISTS player_flag_preference_scope_guard ON player_flag_preferences;
DROP TRIGGER IF EXISTS flags_invalidate_access_after_control_change ON flags;

ALTER TABLE player_flag_preferences DROP COLUMN IF EXISTS default_custom_group_id;
ALTER TABLE flag_travel_commands DROP COLUMN IF EXISTS custom_group_id;
ALTER TABLE flags DROP COLUMN IF EXISTS custom_requests_enabled;

DROP TABLE IF EXISTS custom_flag_group_requests;
DROP TABLE IF EXISTS custom_flag_group_overrides;
DROP TABLE IF EXISTS custom_flag_group_memberships;
DROP TABLE IF EXISTS custom_flag_access_groups;
DROP TABLE IF EXISTS flag_passage_requests;
DROP TABLE IF EXISTS flag_access_overrides;

DROP FUNCTION IF EXISTS enforce_custom_group_membership_scope();
DROP FUNCTION IF EXISTS enforce_custom_group_override_scope();
DROP FUNCTION IF EXISTS enforce_player_flag_preference_scope();
DROP FUNCTION IF EXISTS enforce_custom_passage_request_scope();
DROP FUNCTION IF EXISTS invalidate_personal_flag_access_lifecycle();
DROP FUNCTION IF EXISTS bump_custom_group_member_revisions();
DROP FUNCTION IF EXISTS delete_disposable_empty_custom_group();
DROP FUNCTION IF EXISTS bump_custom_group_access_revisions();

CREATE OR REPLACE FUNCTION prepare_personal_flag_access_change() RETURNS trigger AS $$
BEGIN
  IF OLD.control_type IS DISTINCT FROM NEW.control_type
     OR OLD.owner_id IS DISTINCT FROM NEW.owner_id THEN
    NEW.access_mode := CASE
      WHEN NEW.control_type IN ('city', 'city_seat') THEN 'public'
      ELSE 'private'
    END;
    NEW.jump_toll_gold := 0;
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
  )
  OR (
    control_type IN ('kingdom', 'kingdom_seat')
    AND access_mode = 'private'
    AND jump_toll_gold = 0
  )
);

ALTER TABLE flags ENABLE TRIGGER USER;
ALTER TABLE player_flag_preferences ENABLE TRIGGER USER;

COMMENT ON CONSTRAINT flags_access_mode_check ON flags IS
  'Personal flag access supports Public, Normal, and Private modes only.';
