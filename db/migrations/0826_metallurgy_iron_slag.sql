-- Metallurgy progression and durable per-unit Iron smelting outcomes.

INSERT INTO item_definitions (
  item_id, display_name, category, rarity, stackable, max_stack,
  droppable, manor_storable, market_tradable, market_fungible,
  market_identity, supported_variants
)
VALUES (
  'slag', 'Slag', 'resource', 'common', true, 250,
  true, true, false, false, NULL, ARRAY['default']::text[]
)
ON CONFLICT (item_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  category = EXCLUDED.category,
  rarity = EXCLUDED.rarity,
  stackable = EXCLUDED.stackable,
  max_stack = EXCLUDED.max_stack,
  droppable = EXCLUDED.droppable,
  manor_storable = EXCLUDED.manor_storable,
  market_tradable = EXCLUDED.market_tradable,
  market_fungible = EXCLUDED.market_fungible,
  market_identity = EXCLUDED.market_identity,
  supported_variants = EXCLUDED.supported_variants,
  updated_at = now();

ALTER TABLE player_profession_progress
  DROP CONSTRAINT IF EXISTS player_profession_progress_profession_id_check;
ALTER TABLE player_profession_progress
  ADD CONSTRAINT player_profession_progress_profession_id_check CHECK (
    profession_id IN ('woodcutter','miner','builder','hunter','oil_worker','breeder','metallurgy')
  );

ALTER TABLE mastery_progression_operations
  DROP CONSTRAINT IF EXISTS mastery_progression_operations_profession_id_check,
  DROP CONSTRAINT IF EXISTS mastery_progression_operations_source_type_check;
ALTER TABLE mastery_progression_operations
  ADD CONSTRAINT mastery_progression_operations_profession_id_check CHECK (
    profession_id IN ('woodcutter','miner','builder','hunter','oil_worker','breeder','metallurgy')
  ),
  ADD CONSTRAINT mastery_progression_operations_source_type_check CHECK (
    source_type IN (
      'harvest','mining','construction','reinforcement','combat',
      'oil_harvest','breeding','furnace','development'
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
      'master_breeder','master_metallurgy'
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
      'Master Breeder','Master Metallurgy'
    )
  );

ALTER TABLE dev_progression_operations
  DROP CONSTRAINT IF EXISTS dev_progression_operations_progression_type_check;
ALTER TABLE dev_progression_operations
  ADD CONSTRAINT dev_progression_operations_progression_type_check CHECK (progression_type IN (
    'character_level','warrior_level','druid_level','ranger_level','hunter_level',
    'paladin_level','knight_level','cleric_level','ninja_level','woodcutter_level',
    'miner_level','builder_level','hunter_profession_level','oil_worker_level',
    'breeder_level','metallurgy_level','warrior_mastery','reaver_mastery','warden_mastery'
  ));

INSERT INTO player_profession_progress (player_id, profession_id, xp, rank, curve_version)
SELECT id, 'metallurgy', 0, 0, 2 FROM players
ON CONFLICT (player_id, profession_id) DO NOTHING;

ALTER TABLE furnace_smelt_jobs
  DROP CONSTRAINT IF EXISTS furnace_smelt_jobs_recipe_id_check;
ALTER TABLE furnace_smelt_jobs
  ADD CONSTRAINT furnace_smelt_jobs_recipe_id_check CHECK (
    recipe_id IN (
      'iron_bar', 'venomsteel_bar', 'venomsteel_core',
      'fire_bar', 'fire_core', 'lightning_bar', 'lightning_core', 'ice_bar', 'ice_core',
      'slag_recovery'
    )
  );

CREATE TABLE IF NOT EXISTS furnace_smelt_units (
  job_id uuid NOT NULL REFERENCES furnace_smelt_jobs(job_id) ON DELETE RESTRICT,
  unit_index integer NOT NULL CHECK (unit_index >= 1),
  outcome text NOT NULL CHECK (outcome IN ('success','failure')),
  settled_at timestamptz NULL,
  PRIMARY KEY (job_id, unit_index)
);

CREATE INDEX IF NOT EXISTS furnace_smelt_units_settlement_idx
  ON furnace_smelt_units (job_id, settled_at, unit_index);

-- Existing queued Iron jobs were deterministic successes before Metallurgy.
-- Backfill their durable unit outcomes so retained jobs are never rerolled.
INSERT INTO furnace_smelt_units (job_id, unit_index, outcome, settled_at)
SELECT job.job_id,
       unit_index,
       'success',
       CASE WHEN unit_index <= job.collected_quantity
         THEN COALESCE(job.cleared_at, now())
         ELSE NULL
       END
FROM furnace_smelt_jobs AS job
CROSS JOIN LATERAL generate_series(1, job.requested_quantity) AS unit_index
WHERE job.recipe_id = 'iron_bar'
ON CONFLICT (job_id, unit_index) DO NOTHING;
