-- Class System V2 durable cutover. Progression, unlock, equipment, wallet, and class rows are retained.

ALTER TABLE player_class_loadouts
  ADD COLUMN IF NOT EXISTS ultimate_active_id text NULL;

-- Armed replacement attacks may be queued before an entity target is selected.
DO $$
DECLARE queued_target_constraint record;
BEGIN
  FOR queued_target_constraint IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'player_class_runtime'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%queued_target_entity_id%'
  LOOP
    EXECUTE format('ALTER TABLE player_class_runtime DROP CONSTRAINT %I', queued_target_constraint.conname);
  END LOOP;
END $$;
ALTER TABLE player_class_runtime DROP CONSTRAINT IF EXISTS player_class_runtime_queued_tick_check;
ALTER TABLE player_class_runtime ADD CONSTRAINT player_class_runtime_queued_tick_check
  CHECK ((queued_ability_id IS NULL) = (queued_at_tick IS NULL));

-- Translate regular skills by their stable unlock/choice position. Invalid or obsolete entries are discarded.
UPDATE player_class_loadouts AS loadout
SET reset_active_ids = ARRAY[NULL,NULL]::text[],
    normal_active_ids = ARRAY[
      CASE
        WHEN progress.mastery_rank < 1 THEN NULL
        WHEN loadout.normal_active_ids[1] IS NULL AND loadout.normal_active_ids[2] IS NULL THEN
          CASE loadout.class_id
            WHEN 'warrior' THEN 'warrior_v2_sundering_arc' WHEN 'ranger' THEN 'ranger_v2_throughshot'
            WHEN 'paladin' THEN 'paladin_v2_judgment' WHEN 'ninja' THEN 'ninja_v2_twin_fang'
            WHEN 'cleric' THEN 'cleric_v2_radiant_bolt' END
        ELSE CASE loadout.class_id
          WHEN 'warrior' THEN CASE loadout.normal_active_ids[1]
            WHEN 'warrior_v2_sundering_arc' THEN 'warrior_v2_sundering_arc' WHEN 'warrior_v2_iron_reversal' THEN 'warrior_v2_iron_reversal' WHEN 'warrior_v2_faultline' THEN 'warrior_v2_faultline' WHEN 'warrior_v2_rallying_roar' THEN 'warrior_v2_rallying_roar'
            WHEN 'warrior_empowered_hit' THEN 'warrior_v2_sundering_arc' WHEN 'warrior_anger_explosion' THEN 'warrior_v2_iron_reversal'
            WHEN 'warrior_concussive_blow' THEN 'warrior_v2_faultline' WHEN 'warrior_battle_cry' THEN 'warrior_v2_rallying_roar' END
          WHEN 'ranger' THEN CASE loadout.normal_active_ids[1]
            WHEN 'ranger_v2_throughshot' THEN 'ranger_v2_throughshot' WHEN 'ranger_v2_threefold_volley' THEN 'ranger_v2_threefold_volley' WHEN 'ranger_v2_marked_quarry' THEN 'ranger_v2_marked_quarry' WHEN 'ranger_v2_snare_shot' THEN 'ranger_v2_snare_shot'
            WHEN 'ranger_power_shot' THEN 'ranger_v2_throughshot' WHEN 'ranger_rapid_shot' THEN 'ranger_v2_threefold_volley'
            WHEN 'ranger_hunters_mark' THEN 'ranger_v2_marked_quarry' WHEN 'ranger_crippling_shot' THEN 'ranger_v2_snare_shot' END
          WHEN 'paladin' THEN CASE loadout.normal_active_ids[1]
            WHEN 'paladin_v2_judgment' THEN 'paladin_v2_judgment' WHEN 'paladin_v2_aegis' THEN 'paladin_v2_aegis' WHEN 'paladin_v2_rebuke' THEN 'paladin_v2_rebuke' WHEN 'paladin_v2_banner_of_resolve' THEN 'paladin_v2_banner_of_resolve'
            WHEN 'paladin_smite' THEN 'paladin_v2_judgment' WHEN 'paladin_holy_mend' THEN 'paladin_v2_aegis'
            WHEN 'paladin_holy_guard' THEN 'paladin_v2_rebuke' WHEN 'paladin_blessing_of_valor' THEN 'paladin_v2_banner_of_resolve' END
          WHEN 'cleric' THEN CASE loadout.normal_active_ids[1]
            WHEN 'cleric_v2_radiant_bolt' THEN 'cleric_v2_radiant_bolt' WHEN 'cleric_v2_greater_heal' THEN 'cleric_v2_greater_heal' WHEN 'cleric_v2_renew' THEN 'cleric_v2_renew' WHEN 'cleric_v2_guardian_angel' THEN 'cleric_v2_guardian_angel'
            WHEN 'cleric_holy_bolt' THEN 'cleric_v2_radiant_bolt' WHEN 'cleric_greater_heal' THEN 'cleric_v2_greater_heal'
            WHEN 'cleric_renew' THEN 'cleric_v2_renew' WHEN 'cleric_blessing_of_might' THEN 'cleric_v2_guardian_angel' END
          WHEN 'ninja' THEN CASE loadout.normal_active_ids[1]
            WHEN 'ninja_v2_twin_fang' THEN 'ninja_v2_twin_fang' WHEN 'ninja_v2_smoke_bomb' THEN 'ninja_v2_smoke_bomb'
            WHEN 'ninja_v2_shadowstep' THEN 'ninja_v2_shadowstep' WHEN 'ninja_v2_shuriken_fan' THEN 'ninja_v2_shuriken_fan' END END
      END,
      CASE WHEN progress.mastery_rank >= 4 THEN CASE loadout.class_id
        WHEN 'warrior' THEN CASE loadout.normal_active_ids[2] WHEN 'warrior_v2_sundering_arc' THEN 'warrior_v2_sundering_arc' WHEN 'warrior_v2_iron_reversal' THEN 'warrior_v2_iron_reversal' WHEN 'warrior_v2_faultline' THEN 'warrior_v2_faultline' WHEN 'warrior_v2_rallying_roar' THEN 'warrior_v2_rallying_roar' WHEN 'warrior_empowered_hit' THEN 'warrior_v2_sundering_arc' WHEN 'warrior_anger_explosion' THEN 'warrior_v2_iron_reversal' WHEN 'warrior_concussive_blow' THEN 'warrior_v2_faultline' WHEN 'warrior_battle_cry' THEN 'warrior_v2_rallying_roar' END
        WHEN 'ranger' THEN CASE loadout.normal_active_ids[2] WHEN 'ranger_v2_throughshot' THEN 'ranger_v2_throughshot' WHEN 'ranger_v2_threefold_volley' THEN 'ranger_v2_threefold_volley' WHEN 'ranger_v2_marked_quarry' THEN 'ranger_v2_marked_quarry' WHEN 'ranger_v2_snare_shot' THEN 'ranger_v2_snare_shot' WHEN 'ranger_power_shot' THEN 'ranger_v2_throughshot' WHEN 'ranger_rapid_shot' THEN 'ranger_v2_threefold_volley' WHEN 'ranger_hunters_mark' THEN 'ranger_v2_marked_quarry' WHEN 'ranger_crippling_shot' THEN 'ranger_v2_snare_shot' END
        WHEN 'paladin' THEN CASE loadout.normal_active_ids[2] WHEN 'paladin_v2_judgment' THEN 'paladin_v2_judgment' WHEN 'paladin_v2_aegis' THEN 'paladin_v2_aegis' WHEN 'paladin_v2_rebuke' THEN 'paladin_v2_rebuke' WHEN 'paladin_v2_banner_of_resolve' THEN 'paladin_v2_banner_of_resolve' WHEN 'paladin_smite' THEN 'paladin_v2_judgment' WHEN 'paladin_holy_mend' THEN 'paladin_v2_aegis' WHEN 'paladin_holy_guard' THEN 'paladin_v2_rebuke' WHEN 'paladin_blessing_of_valor' THEN 'paladin_v2_banner_of_resolve' END
        WHEN 'cleric' THEN CASE loadout.normal_active_ids[2] WHEN 'cleric_v2_radiant_bolt' THEN 'cleric_v2_radiant_bolt' WHEN 'cleric_v2_greater_heal' THEN 'cleric_v2_greater_heal' WHEN 'cleric_v2_renew' THEN 'cleric_v2_renew' WHEN 'cleric_v2_guardian_angel' THEN 'cleric_v2_guardian_angel' WHEN 'cleric_holy_bolt' THEN 'cleric_v2_radiant_bolt' WHEN 'cleric_greater_heal' THEN 'cleric_v2_greater_heal' WHEN 'cleric_renew' THEN 'cleric_v2_renew' WHEN 'cleric_blessing_of_might' THEN 'cleric_v2_guardian_angel' END
        WHEN 'ninja' THEN CASE loadout.normal_active_ids[2] WHEN 'ninja_v2_twin_fang' THEN 'ninja_v2_twin_fang' WHEN 'ninja_v2_smoke_bomb' THEN 'ninja_v2_smoke_bomb' WHEN 'ninja_v2_shadowstep' THEN 'ninja_v2_shadowstep' WHEN 'ninja_v2_shuriken_fan' THEN 'ninja_v2_shuriken_fan' END END END
    ]::text[],
    passive_tier_ids = ARRAY[
      CASE WHEN progress.mastery_rank >= 2 THEN CASE loadout.class_id
        WHEN 'warrior' THEN CASE WHEN loadout.passive_tier_ids[1] = 'warrior_bloodthirst' THEN 'warrior_v2_battle_hardened' ELSE 'warrior_v2_retaliation' END
        WHEN 'ranger' THEN CASE WHEN loadout.passive_tier_ids[1] = 'ranger_longshot' THEN 'ranger_v2_clear_shot' ELSE 'ranger_v2_broadheads' END
        WHEN 'paladin' THEN CASE WHEN loadout.passive_tier_ids[1] = 'paladin_merciful_hands' THEN 'paladin_v2_steadfast_faith' ELSE 'paladin_v2_righteous_steel' END
        WHEN 'ninja' THEN CASE WHEN loadout.passive_tier_ids[1] = 'ninja_v2_light_feet' THEN 'ninja_v2_light_feet' ELSE 'ninja_v2_razor_edge' END
        WHEN 'cleric' THEN CASE WHEN loadout.passive_tier_ids[1] = 'cleric_gentle_hands' THEN 'cleric_v2_gentle_light' ELSE 'cleric_v2_sacred_wrath' END END END,
      CASE WHEN progress.mastery_rank >= 7 THEN CASE loadout.class_id
        WHEN 'warrior' THEN CASE WHEN loadout.passive_tier_ids[2] = 'warrior_crowd_fighter' THEN 'warrior_v2_battle_grit' ELSE 'warrior_v2_relentless' END
        WHEN 'ranger' THEN CASE WHEN loadout.passive_tier_ids[2] = 'ranger_executioner' THEN 'ranger_v2_keep_your_distance' ELSE 'ranger_v2_quick_draw' END
        WHEN 'paladin' THEN CASE WHEN loadout.passive_tier_ids[2] = 'paladin_compassion' THEN 'paladin_v2_resolve' ELSE 'paladin_v2_zeal' END
        WHEN 'ninja' THEN CASE WHEN loadout.passive_tier_ids[2] = 'ninja_v2_elusive' THEN 'ninja_v2_elusive' ELSE 'ninja_v2_quick_hands' END
        WHEN 'cleric' THEN CASE WHEN loadout.passive_tier_ids[2] = 'cleric_inspiring_faith' THEN 'cleric_v2_mending_prayer' ELSE 'cleric_v2_battle_prayer' END END END,
      CASE WHEN progress.mastery_rank >= 12 THEN CASE loadout.class_id
        WHEN 'warrior' THEN CASE WHEN loadout.passive_tier_ids[3] = 'warrior_last_stand' THEN 'warrior_v2_juggernaut' ELSE 'warrior_v2_berserker' END
        WHEN 'ranger' THEN CASE WHEN loadout.passive_tier_ids[3] = 'ranger_skirmisher' THEN 'ranger_v2_suppressing_fire' ELSE 'ranger_v2_deadeye' END
        WHEN 'paladin' THEN CASE WHEN loadout.passive_tier_ids[3] = 'paladin_oath_of_protection' THEN 'paladin_v2_oath_of_protection' ELSE 'paladin_v2_oath_of_valor' END
        WHEN 'ninja' THEN CASE WHEN loadout.passive_tier_ids[3] = 'ninja_v2_afterimage' THEN 'ninja_v2_afterimage' ELSE 'ninja_v2_flow_state' END
        WHEN 'cleric' THEN CASE WHEN loadout.passive_tier_ids[3] = 'cleric_benediction' THEN 'cleric_v2_divine_mercy' ELSE 'cleric_v2_holy_fervor' END END END
    ]::text[],
    ultimate_active_id = CASE WHEN progress.mastery_rank >= 14 THEN CASE loadout.class_id
      WHEN 'warrior' THEN 'warrior_v2_worldbreaker' WHEN 'ranger' THEN 'ranger_v2_black_rain'
      WHEN 'paladin' THEN 'paladin_v2_last_bastion' WHEN 'ninja' THEN 'ninja_v2_thousand_shadows'
      WHEN 'cleric' THEN 'cleric_v2_divine_sanctuary' END END,
    revision = loadout.revision + 1
FROM player_class_progress AS progress
WHERE progress.player_id = loadout.player_id AND progress.class_id = loadout.class_id
  AND loadout.class_id IN ('warrior','ranger','paladin','ninja','cleric');

-- Old queued actions and class-only combat state cannot be interpreted under V2.
UPDATE player_class_runtime AS runtime SET queued_ability_id = NULL, queued_target_entity_id = NULL,
  queued_at_tick = NULL, rage_reserved = 0, cooldown_ends_at = '{}'::jsonb,
  status_effects = '[]'::jsonb, counters = '{}'::jsonb,
  combat_generation = runtime.combat_generation + 1, revision = runtime.revision + 1
FROM player_class_profiles AS profile
WHERE profile.player_id = runtime.player_id
  AND profile.active_class_id IN ('warrior','ranger','paladin','ninja','cleric');
UPDATE player_class_resources SET reserved_value = 0, cooldown_ends_at = '{}'::jsonb
WHERE class_id IN ('warrior','ranger','paladin','ninja','cleric');

COMMENT ON COLUMN player_class_loadouts.ultimate_active_id IS
  'Dedicated equipped Class System V2 ultimate; launch-class authority requires Rank 14 and matching class/kind.';
