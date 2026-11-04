-- Mob value pass step C: Advanced General skills now need a one-time discovery offering before
-- Rank 1, and six classes need a one-time writ with Rank 1. Players who already hold Rank 1 or more
-- never pay: record their unlock now, so a later respec does not ask them for the items.
-- General skills use their own id; class writs use 'class_writ:<class id>' (see skillUnlockOfferings.ts).
-- Forward-only and idempotent: existing unlock rows are left alone.
WITH held AS (
  SELECT player_id, skill_id AS unlock_key
  FROM player_skill_ranks
  WHERE rank >= 1
    AND skill_id IN (
      'pierce_armor', 'blight_strike', 'second_wind', 'deathburst', 'pursuit', 'heroism',
      'quarry_sense', 'huntsmans_edge', 'concentration', 'scavenge', 'calm_mind',
      'companion_bond', 'delvers_lore'
    )
  UNION
  SELECT player_id, 'class_writ:' || specialization_id AS unlock_key
  FROM player_specialization_ranks
  WHERE (rank >= 1 OR grandfathered)
    AND specialization_id IN ('knight', 'sentinel', 'mercenary', 'ninja', 'monk', 'druid')
), fresh AS (
  SELECT held.player_id, held.unlock_key,
         'unlock-grandfather:' || held.player_id || ':' || held.unlock_key AS operation_key
  FROM held
  WHERE NOT EXISTS (
    SELECT 1 FROM player_skill_world_unlocks unlock
    WHERE unlock.player_id = held.player_id AND unlock.skill_id = held.unlock_key
  )
), operations AS (
  INSERT INTO skill_point_operations (operation_key, player_id, action, payload, result, completed_at)
  SELECT operation_key, player_id, 'grandfather_unlock',
         jsonb_build_object('unlockKey', unlock_key), jsonb_build_object('migrated', true), now()
  FROM fresh
  ON CONFLICT (operation_key) DO NOTHING
  RETURNING operation_key
)
INSERT INTO player_skill_world_unlocks (player_id, skill_id, operation_key)
SELECT fresh.player_id, fresh.unlock_key, fresh.operation_key
FROM fresh
JOIN operations USING (operation_key);
