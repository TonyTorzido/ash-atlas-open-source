-- Profession Perks V2 and the Oil Worker profession. Existing profession progress is preserved.

ALTER TABLE player_profession_progress
  DROP CONSTRAINT IF EXISTS player_profession_progress_profession_id_check;
ALTER TABLE player_profession_progress
  ADD CONSTRAINT player_profession_progress_profession_id_check CHECK (
    profession_id IN ('woodcutter','miner','builder','hunter','oil_worker')
  );

ALTER TABLE mastery_progression_operations
  DROP CONSTRAINT IF EXISTS mastery_progression_operations_profession_id_check,
  DROP CONSTRAINT IF EXISTS mastery_progression_operations_source_type_check;
ALTER TABLE mastery_progression_operations
  ADD CONSTRAINT mastery_progression_operations_profession_id_check CHECK (
    profession_id IN ('woodcutter','miner','builder','hunter','oil_worker')
  ),
  ADD CONSTRAINT mastery_progression_operations_source_type_check CHECK (
    source_type IN ('harvest','mining','construction','reinforcement','combat','oil_harvest','development')
  );

ALTER TABLE player_mastery_achievements
  DROP CONSTRAINT IF EXISTS player_mastery_achievements_achievement_id_check;
ALTER TABLE player_mastery_achievements
  ADD CONSTRAINT player_mastery_achievements_achievement_id_check CHECK (
    achievement_id IN (
      'master_warrior','master_woodcutter','master_miner','master_builder','master_hunter','master_oil_worker'
    )
  );

ALTER TABLE player_mastery_state
  DROP CONSTRAINT IF EXISTS player_mastery_state_equipped_title_check;
ALTER TABLE player_mastery_state
  ADD CONSTRAINT player_mastery_state_equipped_title_check CHECK (
    equipped_title IS NULL OR equipped_title IN (
      'Master Warrior','Master Woodcutter','Master Miner','Master Builder','Master Hunter','Master Oil Worker'
    )
  );

ALTER TABLE dev_progression_operations
  DROP CONSTRAINT IF EXISTS dev_progression_operations_progression_type_check;
ALTER TABLE dev_progression_operations
  ADD CONSTRAINT dev_progression_operations_progression_type_check CHECK (progression_type IN (
    'character_level',
    'warrior_mastery', 'reaver_mastery', 'warden_mastery',
    'warrior_level', 'hunter_level', 'paladin_level', 'cleric_level',
    'woodcutter_level', 'miner_level', 'builder_level', 'hunter_profession_level', 'oil_worker_level'
  ));

INSERT INTO player_profession_progress (player_id, profession_id, xp, rank, curve_version)
SELECT id, 'oil_worker', 0, 0, 2 FROM players
ON CONFLICT (player_id, profession_id) DO NOTHING;

ALTER TABLE city_oil_well_production
  ADD COLUMN IF NOT EXISTS settled_capacity smallint NOT NULL DEFAULT 120 CHECK (settled_capacity BETWEEN 120 AND 150),
  DROP CONSTRAINT IF EXISTS city_oil_well_production_stored_crude_oil_check;
ALTER TABLE city_oil_well_production
  ADD CONSTRAINT city_oil_well_production_stored_crude_oil_check CHECK (
    stored_crude_oil BETWEEN 0 AND 150
  );
