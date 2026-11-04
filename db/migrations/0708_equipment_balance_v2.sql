-- Equipment Balance V2: universal combat stats, character-level legality,
-- monotonic player challenge profiles, and durable Population V2 mob levels.
-- Numbered after the accepted weekly-leaderboards migration.

ALTER TABLE player_equipment_state
  ADD COLUMN current_combat_gear_level smallint NOT NULL DEFAULT 0
    CHECK (current_combat_gear_level BETWEEN 0 AND 25),
  ADD COLUMN unlocked_combat_gear_level smallint NOT NULL DEFAULT 0
    CHECK (unlocked_combat_gear_level BETWEEN 0 AND 25),
  ADD COLUMN challenge_profile_version integer NOT NULL DEFAULT 2
    CHECK (challenge_profile_version = 2),
  ADD CONSTRAINT player_equipment_state_unlocked_gear_monotonic_check
    CHECK (unlocked_combat_gear_level >= current_combat_gear_level);

WITH contributors AS (
  SELECT
    state.player_id,
    COALESCE(max(item.item_level) FILTER (
      WHERE item.location = 'equipped' AND item.equipped_slot = 'melee'
    ), 0) AS melee,
    COALESCE(max(item.item_level) FILTER (
      WHERE item.location = 'equipped' AND item.equipped_slot = 'chest'
    ), 0) AS chest,
    COALESCE(max(item.item_level) FILTER (
      WHERE item.location = 'equipped' AND item.equipped_slot = 'secondary'
    ), 0) AS secondary
  FROM player_equipment_state state
  LEFT JOIN equipment_instances item
    ON item.owner_player_id = state.player_id
  GROUP BY state.player_id
), resolved AS (
  SELECT
    player_id,
    floor((melee + chest + secondary) / 3.0)::integer AS gear_level
  FROM contributors
)
UPDATE player_equipment_state state
SET current_combat_gear_level = resolved.gear_level,
    unlocked_combat_gear_level = greatest(
      state.unlocked_combat_gear_level,
      resolved.gear_level
    ),
    challenge_profile_version = 2
FROM resolved
WHERE resolved.player_id = state.player_id;

-- Definitions, not retained instance identity, own the active balance version.
UPDATE equipment_instances
SET balance_version = 2
WHERE balance_version <> 2;

ALTER TABLE generated_world_mobs
  ADD COLUMN combat_level smallint NULL
    CHECK (combat_level BETWEEN 0 AND 25),
  ADD COLUMN combat_tier text NULL
    CHECK (combat_tier IN ('common', 'uncommon', 'rare', 'epic', 'legendary')),
  ADD COLUMN combat_balance_version integer NULL
    CHECK (combat_balance_version = 2),
  ADD COLUMN combat_profile_claimed_at timestamptz NULL,
  ADD COLUMN combat_profile_source text NULL
    CHECK (combat_profile_source IN ('zone_player_profile', 'background_fallback')),
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

CREATE INDEX generated_world_mobs_unclaimed_combat_profile_idx
  ON generated_world_mobs (
    physical_population_zone_v2_id,
    population_v2_plan_id,
    encounter_id
  )
  WHERE combat_level IS NULL
    AND killed_at IS NULL
    AND NOT population_v2_suppressed;

COMMENT ON COLUMN player_equipment_state.unlocked_combat_gear_level IS
  'Monotonic maximum committed active gear profile used for shared-world mob challenge claims.';
COMMENT ON COLUMN generated_world_mobs.combat_level IS
  'One durable Equipment Balance V2 challenge level claimed for the mob life; pack members share it.';
