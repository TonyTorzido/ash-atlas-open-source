-- Lower the character, equipment, and monster level cap from 40 back to 25
-- until Level 30+ content exists (packages/shared/src/progression.ts
-- CURRENT_LEVEL_CAP). Data above 25 is clamped; the 0..40 range constraints
-- added by 0879 stay wide so a later raise only needs the constant, a tier
-- re-band, and a level re-derivation, and so historical XP/upgrade ledger rows
-- recorded while the cap was 40 remain valid.

-- Character level. Lifetime XP is never touched: XP earned past Level 25 stays
-- banked in total_xp, so re-deriving levels from total_xp on the next raise
-- (as 0879 did) restores those levels. While capped, that XP only counts toward
-- post-cap Enchantment Stone cycles earned from new XP.
UPDATE player_progression_profiles
SET level = 25,
    persistence_version = persistence_version + 1,
    updated_at = now()
WHERE level > 25;

-- Skill points: one point per level through the cap. Points already spent above
-- the new entitlement stay spent (grandfathered with zero available), matching
-- lockAndReconcileSkillPointState and 0782.
WITH actual_spending AS (
  SELECT state.player_id,
         LEAST(25, GREATEST(0, progression.level)) AS level_entitlement,
         COALESCE(general.total_spent, 0) + COALESCE(specialization.total_spent, 0) AS total_spent
  FROM player_skill_point_state AS state
  JOIN player_progression_profiles AS progression ON progression.player_id = state.player_id
  LEFT JOIN (
    SELECT player_id, SUM(points_spent)::integer AS total_spent
    FROM player_skill_ranks GROUP BY player_id
  ) AS general ON general.player_id = state.player_id
  LEFT JOIN (
    SELECT player_id, SUM(points_spent)::integer AS total_spent
    FROM player_specialization_ranks GROUP BY player_id
  ) AS specialization ON specialization.player_id = state.player_id
  WHERE state.total_earned > 25
)
UPDATE player_skill_point_state AS state
SET total_earned = GREATEST(actual.level_entitlement, actual.total_spent),
    total_spent = actual.total_spent,
    revision = state.revision + 1,
    updated_at = now()
FROM actual_spending AS actual
WHERE state.player_id = actual.player_id
  AND (state.total_earned, state.total_spent) IS DISTINCT FROM
      (GREATEST(actual.level_entitlement, actual.total_spent), actual.total_spent);

-- Equipment item level. Paid upgrade levels above 25 are banked per instance so
-- the next cap raise can restore them instead of losing the gold spent.
CREATE TABLE equipment_level_cap_banked_levels (
  instance_id uuid PRIMARY KEY REFERENCES equipment_instances(instance_id) ON DELETE CASCADE,
  banked_item_level smallint NOT NULL CHECK (banked_item_level BETWEEN 26 AND 40),
  clamped_to_level smallint NOT NULL CHECK (clamped_to_level = 25),
  clamped_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE equipment_level_cap_banked_levels IS
  'Item levels above 25 clamped by 0885_level_cap_25; restore them when the level cap is raised again.';

INSERT INTO equipment_level_cap_banked_levels (instance_id, banked_item_level, clamped_to_level)
SELECT instance_id, item_level, 25
FROM equipment_instances
WHERE item_level > 25
ON CONFLICT (instance_id) DO NOTHING;

UPDATE equipment_instances
SET item_level = 25
WHERE item_level > 25;

UPDATE player_equipment_state
SET current_combat_gear_level = LEAST(current_combat_gear_level, 25),
    unlocked_combat_gear_level = LEAST(unlocked_combat_gear_level, 25)
WHERE current_combat_gear_level > 25
   OR unlocked_combat_gear_level > 25;

-- Monster combat level and challenge tier: clamp claimed levels to 25 and move
-- tiers back onto the equal 25-cap bands (0-5/6-10/11-15/16-20/21-25) that
-- mobChallengeTier derives from the cap.
ALTER TABLE generated_world_mobs
  DROP CONSTRAINT generated_world_mobs_combat_profile_complete_check;

UPDATE generated_world_mobs
SET combat_level = LEAST(combat_level, 25),
    combat_tier = CASE
      WHEN LEAST(combat_level, 25) <= 5 THEN 'common'
      WHEN LEAST(combat_level, 25) <= 10 THEN 'uncommon'
      WHEN LEAST(combat_level, 25) <= 15 THEN 'rare'
      WHEN LEAST(combat_level, 25) <= 20 THEN 'epic'
      ELSE 'legendary'
    END
WHERE combat_level IS NOT NULL
  AND (
    combat_level > 25
    OR combat_tier IS DISTINCT FROM CASE
      WHEN combat_level <= 5 THEN 'common'
      WHEN combat_level <= 10 THEN 'uncommon'
      WHEN combat_level <= 15 THEN 'rare'
      WHEN combat_level <= 20 THEN 'epic'
      ELSE 'legendary'
    END
  );

ALTER TABLE generated_world_mobs
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
        WHEN combat_level <= 5 THEN 'common'
        WHEN combat_level <= 10 THEN 'uncommon'
        WHEN combat_level <= 15 THEN 'rare'
        WHEN combat_level <= 20 THEN 'epic'
        ELSE 'legendary'
      END
    )
  );
