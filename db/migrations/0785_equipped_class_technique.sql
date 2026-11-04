ALTER TABLE player_specialization_state
  ADD COLUMN IF NOT EXISTS equipped_class_technique_id text NULL;

DO $$ BEGIN
  ALTER TABLE player_specialization_state
    ADD CONSTRAINT player_specialization_state_equipped_class_technique_check
    CHECK (equipped_class_technique_id IS NULL OR equipped_class_technique_id IN (
      'v3_warrior_anger_explosion', 'v3_warrior_is_that_it',
      'v3_ranger_double_tap', 'v3_ranger_explosive_arrow',
      'v3_ninja_shadow_mark', 'v3_ninja_parkour',
      'v3_paladin_aegis', 'v3_paladin_smite',
      'v3_cleric_lifebinder', 'v3_cleric_purifier'
    ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN player_specialization_state.equipped_class_technique_id IS
  'The single equipped Skill System V3 Rank-3 class technique; cooldowns remain in player_skill_runtime.';
