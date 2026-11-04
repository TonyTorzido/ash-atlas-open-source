ALTER TABLE flags
  ADD COLUMN IF NOT EXISTS anchor_kind text NOT NULL DEFAULT 'flag';

ALTER TABLE flags
  DROP CONSTRAINT IF EXISTS flags_anchor_kind_valid,
  ADD CONSTRAINT flags_anchor_kind_valid
    CHECK (anchor_kind IN ('flag', 'buoy')),
  DROP CONSTRAINT IF EXISTS flags_buoy_personal_base_only,
  ADD CONSTRAINT flags_buoy_personal_base_only CHECK (
    anchor_kind = 'flag'
    OR (
      control_type = 'personal'
      AND city_id IS NULL
      AND kingdom_id IS NULL
      AND reinforcement_level = 0
      AND atlas_shrine_slot_number IS NULL
    )
  );
