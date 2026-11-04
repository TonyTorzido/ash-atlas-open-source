-- City Kennel facility and five-rank Breeder profession.

ALTER TABLE city_structures
  DROP CONSTRAINT IF EXISTS city_structures_structure_type_check,
  DROP CONSTRAINT IF EXISTS city_structures_owner_shape_check,
  DROP CONSTRAINT IF EXISTS city_structures_civic_tier_check;

ALTER TABLE city_structures
  ADD CONSTRAINT city_structures_structure_type_check CHECK (
    structure_type IN (
      'city_house', 'mayor_house', 'oil_well', 'warehouse', 'cistern_warrens',
      'salon', 'city_kennel', 'market', 'monument', 'weaponsmith', 'armory'
    )
  ),
  ADD CONSTRAINT city_structures_owner_shape_check CHECK (
    (
      structure_type IN ('city_house', 'mayor_house', 'oil_well')
      AND owner_player_id IS NOT NULL
    )
    OR (
      structure_type IN (
        'warehouse', 'cistern_warrens', 'salon', 'city_kennel', 'market',
        'monument', 'weaponsmith', 'armory'
      )
      AND owner_player_id IS NULL
    )
  ),
  ADD CONSTRAINT city_structures_civic_tier_check CHECK (
    (structure_type IN ('market', 'oil_well', 'cistern_warrens', 'salon', 'city_kennel') AND tier = 1)
    OR (structure_type = 'monument' AND tier BETWEEN 1 AND 3)
    OR structure_type NOT IN ('market', 'oil_well', 'cistern_warrens', 'salon', 'city_kennel', 'monument')
  );

CREATE UNIQUE INDEX city_structures_one_reserved_city_kennel_per_city_idx
  ON city_structures (city_id)
  WHERE structure_type = 'city_kennel' AND state IN ('constructing', 'active');

ALTER TABLE player_profession_progress
  DROP CONSTRAINT IF EXISTS player_profession_progress_profession_id_check;
ALTER TABLE player_profession_progress
  ADD CONSTRAINT player_profession_progress_profession_id_check CHECK (
    profession_id IN ('woodcutter','miner','builder','hunter','oil_worker','breeder')
  );

ALTER TABLE mastery_progression_operations
  DROP CONSTRAINT IF EXISTS mastery_progression_operations_profession_id_check,
  DROP CONSTRAINT IF EXISTS mastery_progression_operations_source_type_check;
ALTER TABLE mastery_progression_operations
  ADD CONSTRAINT mastery_progression_operations_profession_id_check CHECK (
    profession_id IN ('woodcutter','miner','builder','hunter','oil_worker','breeder')
  ),
  ADD CONSTRAINT mastery_progression_operations_source_type_check CHECK (
    source_type IN (
      'harvest','mining','construction','reinforcement','combat',
      'oil_harvest','breeding','development'
    )
  );

ALTER TABLE player_mastery_achievements
  DROP CONSTRAINT IF EXISTS player_mastery_achievements_achievement_id_check;
ALTER TABLE player_mastery_achievements
  ADD CONSTRAINT player_mastery_achievements_achievement_id_check CHECK (
    achievement_id IN (
      'master_warrior','master_druid','master_ranger','master_paladin',
      'master_knight','master_cleric','master_ninja','master_woodcutter',
      'master_miner','master_builder','master_hunter','master_oil_worker',
      'master_breeder'
    )
  );

ALTER TABLE player_mastery_state
  DROP CONSTRAINT IF EXISTS player_mastery_state_equipped_title_check;
ALTER TABLE player_mastery_state
  ADD CONSTRAINT player_mastery_state_equipped_title_check CHECK (
    equipped_title IS NULL OR equipped_title IN (
      'Master Warrior','Master Druid','Master Ranger','Master Paladin',
      'Master Knight','Master Cleric','Master Ninja','Master Woodcutter',
      'Master Miner','Master Builder','Master Hunter','Master Oil Worker',
      'Master Breeder'
    )
  );

ALTER TABLE dev_progression_operations
  DROP CONSTRAINT IF EXISTS dev_progression_operations_progression_type_check;
ALTER TABLE dev_progression_operations
  ADD CONSTRAINT dev_progression_operations_progression_type_check CHECK (progression_type IN (
    'character_level','warrior_level','druid_level','ranger_level','hunter_level',
    'paladin_level','knight_level','cleric_level','ninja_level','woodcutter_level',
    'miner_level','builder_level','hunter_profession_level','oil_worker_level',
    'breeder_level','warrior_mastery','reaver_mastery','warden_mastery'
  ));

INSERT INTO player_profession_progress (player_id, profession_id, xp, rank, curve_version)
SELECT id, 'breeder', 0, 0, 2 FROM players
ON CONFLICT (player_id, profession_id) DO NOTHING;
