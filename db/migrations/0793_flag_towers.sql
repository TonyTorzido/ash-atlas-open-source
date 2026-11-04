ALTER TABLE flags
  DROP CONSTRAINT IF EXISTS flags_reinforcement_level_check;
ALTER TABLE flags
  ADD CONSTRAINT flags_reinforcement_level_check
  CHECK (reinforcement_level BETWEEN 0 AND 3);

ALTER TABLE flags DROP CONSTRAINT IF EXISTS flags_tower_personal_check;
ALTER TABLE flags ADD CONSTRAINT flags_tower_personal_check CHECK (
  reinforcement_level <> 3
  OR (
    anchor_kind = 'flag'
    AND control_type = 'personal'
    AND city_id IS NULL
    AND kingdom_id IS NULL
  )
);

ALTER TABLE flags DROP CONSTRAINT IF EXISTS flags_health_valid;
ALTER TABLE flags ADD CONSTRAINT flags_health_valid CHECK (
  (
    anchor_kind = 'flag' AND reinforcement_level IN (1, 3)
    AND health IS NOT NULL
    AND maximum_health IS NOT NULL
    AND health BETWEEN 0 AND maximum_health
    AND maximum_health = 200
  )
  OR
  (
    NOT (anchor_kind = 'flag' AND reinforcement_level IN (1, 3))
    AND health IS NULL
    AND maximum_health IS NULL
  )
);

ALTER TABLE flag_material_spend
  DROP CONSTRAINT IF EXISTS flag_material_spend_stage_check;
ALTER TABLE flag_material_spend
  ADD CONSTRAINT flag_material_spend_stage_check
  CHECK (stage IN ('base', 'stone', 'atlas_shrine', 'tower'));

COMMENT ON COLUMN flags.health IS
  'Current durability for Stone Flags and Towers; NULL for base flags, buoys, and Atlas Shrines.';
COMMENT ON COLUMN flags.maximum_health IS
  'Maximum durability for Stone Flags and Towers; NULL for base flags, buoys, and Atlas Shrines.';
