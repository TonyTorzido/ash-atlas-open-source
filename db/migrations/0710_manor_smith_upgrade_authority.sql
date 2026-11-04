ALTER TABLE equipment_upgrade_operations
  ADD COLUMN IF NOT EXISTS authority_kind text NOT NULL DEFAULT 'legacy'
    CHECK (authority_kind IN ('legacy', 'city_facility', 'manor_smith')),
  ADD COLUMN IF NOT EXISTS authority_source text NULL
    CHECK (authority_source IS NULL OR length(authority_source) BETWEEN 1 AND 160),
  ADD COLUMN IF NOT EXISTS runtime_authority_session_id text NULL
    CHECK (
      runtime_authority_session_id IS NULL
      OR length(runtime_authority_session_id) BETWEEN 1 AND 160
    ),
  ADD COLUMN IF NOT EXISTS authority_movement_sequence bigint NULL
    CHECK (authority_movement_sequence IS NULL OR authority_movement_sequence >= 0);

COMMENT ON COLUMN equipment_upgrade_operations.authority_kind IS
  'Stable authority category for the upgrade; manor Smithing Station operations use manor_smith.';
COMMENT ON COLUMN equipment_upgrade_operations.authority_source IS
  'Stable authority source identity; manor_smith operations use the visited manor ID.';
COMMENT ON COLUMN equipment_upgrade_operations.runtime_authority_session_id IS
  'Ephemeral manor session fence used only to validate manor_smith request intent and replay.';
COMMENT ON COLUMN equipment_upgrade_operations.authority_movement_sequence IS
  'Authoritative manor movement-sequence fence supplied with a manor_smith request.';
