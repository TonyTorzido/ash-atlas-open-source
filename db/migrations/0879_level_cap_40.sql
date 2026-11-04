-- Raise the character, equipment, and monster level cap from 25 to 40.
-- Widens every live 0..25 character/equipment/mob level constraint, moves
-- persisted monster challenge tiers onto the 0-8/9-16/17-24/25-32/33-40 bands,
-- and re-derives stored character levels for XP banked past the old cap.
-- Class, profession, and Hunter ranks keep their own 0..25 ranges.

-- Character level.
ALTER TABLE player_progression_profiles
  DROP CONSTRAINT player_progression_profiles_level_check,
  ADD CONSTRAINT player_progression_profiles_level_check CHECK (level BETWEEN 0 AND 40);
ALTER TABLE xp_operations
  DROP CONSTRAINT xp_operations_previous_level_check,
  DROP CONSTRAINT xp_operations_resulting_level_check,
  ADD CONSTRAINT xp_operations_previous_level_check CHECK (previous_level BETWEEN 0 AND 40),
  ADD CONSTRAINT xp_operations_resulting_level_check CHECK (resulting_level BETWEEN 0 AND 40);
ALTER TABLE xp_events
  DROP CONSTRAINT xp_events_resulting_level_check,
  ADD CONSTRAINT xp_events_resulting_level_check CHECK (resulting_level BETWEEN 0 AND 40);
ALTER TABLE player_death_xp_penalties
  DROP CONSTRAINT player_death_xp_penalties_previous_level_check,
  DROP CONSTRAINT player_death_xp_penalties_resulting_level_check,
  ADD CONSTRAINT player_death_xp_penalties_previous_level_check CHECK (previous_level BETWEEN 0 AND 40),
  ADD CONSTRAINT player_death_xp_penalties_resulting_level_check CHECK (resulting_level BETWEEN 0 AND 40);
ALTER TABLE character_xp_curve_adjustments
  DROP CONSTRAINT character_xp_curve_adjustments_previous_level_check,
  DROP CONSTRAINT character_xp_curve_adjustments_resulting_level_check,
  ADD CONSTRAINT character_xp_curve_adjustments_previous_level_check CHECK (previous_level BETWEEN 0 AND 40),
  ADD CONSTRAINT character_xp_curve_adjustments_resulting_level_check CHECK (resulting_level BETWEEN 0 AND 40);
ALTER TABLE combat_reward_participants
  DROP CONSTRAINT combat_reward_participants_player_level_check,
  ADD CONSTRAINT combat_reward_participants_player_level_check CHECK (player_level BETWEEN 0 AND 40);
-- Developer progression targets cover character level (now 0..40) as well as
-- class ranks; the service still enforces each progression type's own maximum.
ALTER TABLE dev_progression_operations
  DROP CONSTRAINT dev_progression_operations_target_rank_check,
  ADD CONSTRAINT dev_progression_operations_target_rank_check CHECK (target_rank BETWEEN 0 AND 40);

-- Equipment item level.
ALTER TABLE equipment_instances
  DROP CONSTRAINT equipment_instances_item_level_check,
  ADD CONSTRAINT equipment_instances_item_level_check CHECK (item_level BETWEEN 0 AND 40);
ALTER TABLE equipment_upgrade_operations
  DROP CONSTRAINT equipment_upgrade_operations_expected_level_check,
  DROP CONSTRAINT equipment_upgrade_operations_level_before_check,
  DROP CONSTRAINT equipment_upgrade_operations_level_after_check,
  ADD CONSTRAINT equipment_upgrade_operations_expected_level_check CHECK (expected_level BETWEEN 0 AND 40),
  ADD CONSTRAINT equipment_upgrade_operations_level_before_check CHECK (level_before BETWEEN 0 AND 39),
  ADD CONSTRAINT equipment_upgrade_operations_level_after_check CHECK (level_after BETWEEN 1 AND 40);
ALTER TABLE player_equipment_state
  DROP CONSTRAINT player_equipment_state_current_combat_gear_level_check,
  DROP CONSTRAINT player_equipment_state_unlocked_combat_gear_level_check,
  ADD CONSTRAINT player_equipment_state_current_combat_gear_level_check CHECK (current_combat_gear_level BETWEEN 0 AND 40),
  ADD CONSTRAINT player_equipment_state_unlocked_combat_gear_level_check CHECK (unlocked_combat_gear_level BETWEEN 0 AND 40);

-- Monster combat level and challenge tier. Claimed levels are never lowered;
-- only the tier label moves to the new bands.
ALTER TABLE generated_world_mobs
  DROP CONSTRAINT generated_world_mobs_combat_level_check,
  DROP CONSTRAINT generated_world_mobs_combat_profile_complete_check;

UPDATE generated_world_mobs
SET combat_tier = CASE
  WHEN combat_level <= 8 THEN 'common'
  WHEN combat_level <= 16 THEN 'uncommon'
  WHEN combat_level <= 24 THEN 'rare'
  WHEN combat_level <= 32 THEN 'epic'
  ELSE 'legendary'
END
WHERE combat_level IS NOT NULL
  AND combat_tier IS DISTINCT FROM CASE
    WHEN combat_level <= 8 THEN 'common'
    WHEN combat_level <= 16 THEN 'uncommon'
    WHEN combat_level <= 24 THEN 'rare'
    WHEN combat_level <= 32 THEN 'epic'
    ELSE 'legendary'
  END;

ALTER TABLE generated_world_mobs
  ADD CONSTRAINT generated_world_mobs_combat_level_check CHECK (combat_level BETWEEN 0 AND 40),
  ADD CONSTRAINT generated_world_mobs_combat_profile_complete_check CHECK (
    (
      combat_level IS NULL
      AND combat_tier IS NULL
      AND combat_balance_version IS NULL
      AND combat_profile_claimed_at IS NULL
      AND combat_profile_source IS NULL
    )
    OR
    (
      combat_level IS NOT NULL
      AND combat_tier IS NOT NULL
      AND combat_balance_version = 2
      AND combat_profile_claimed_at IS NOT NULL
      AND combat_profile_source IS NOT NULL
      AND combat_tier = CASE
        WHEN combat_level <= 8 THEN 'common'
        WHEN combat_level <= 16 THEN 'uncommon'
        WHEN combat_level <= 24 THEN 'rare'
        WHEN combat_level <= 32 THEN 'epic'
        ELSE 'legendary'
      END
    )
  );

-- XP banked past the old Level 25 cap now counts toward Levels 26-40
-- (packages/shared/src/progression.ts TOTAL_XP_FOR_LEVEL). Lifetime XP is
-- unchanged; only the derived level column is refreshed.
WITH thresholds(level, threshold) AS (
  VALUES
    (25, 1000000), (26, 1129902), (27, 1275743), (28, 1439481), (29, 1623310),
    (30, 1829697), (31, 2061409), (32, 2321554), (33, 2613621), (34, 2941527),
    (35, 3309670), (36, 3722986), (37, 4187020), (38, 4707995), (39, 5292897),
    (40, 5949572)
), resolved AS (
  SELECT profile.player_id, max(thresholds.level) AS level
  FROM player_progression_profiles AS profile
  JOIN thresholds ON thresholds.threshold <= profile.total_xp
  WHERE profile.total_xp >= 1000000
  GROUP BY profile.player_id
)
UPDATE player_progression_profiles AS profile
SET level = resolved.level,
    persistence_version = profile.persistence_version + 1,
    updated_at = now()
FROM resolved
WHERE profile.player_id = resolved.player_id
  AND profile.level <> resolved.level;
