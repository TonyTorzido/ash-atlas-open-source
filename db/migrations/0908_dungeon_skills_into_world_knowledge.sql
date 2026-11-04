-- Fold the token-unlocked "dungeon skills" into World Knowledge discovery:
--   stonefinder -> deepstone_lore, beastlore -> wildkin_lore (Halfling Lore), wardens_gift -> grove_lore.
-- A turn-in discovers the skill; ranks are then bought with General Skill Points. Players who had
-- already turned tokens in keep the discovery (at rank 0), and the old table is retired, not dropped.
WITH legacy AS (
  SELECT player_id,
         CASE skill_id
           WHEN 'stonefinder' THEN 'deepstone_lore'
           WHEN 'beastlore' THEN 'wildkin_lore'
           WHEN 'wardens_gift' THEN 'grove_lore'
         END AS skill_id,
         unlocked_at
  FROM player_dungeon_skills
), fresh AS (
  SELECT legacy.player_id, legacy.skill_id, legacy.unlocked_at,
         'dungeon-skill-migration:' || legacy.player_id || ':' || legacy.skill_id AS operation_key
  FROM legacy
  WHERE legacy.skill_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM player_skill_world_unlocks unlock
      WHERE unlock.player_id = legacy.player_id AND unlock.skill_id = legacy.skill_id
    )
), operations AS (
  INSERT INTO skill_point_operations (operation_key, player_id, action, payload, result, created_at, completed_at)
  SELECT operation_key, player_id, 'discover_world_knowledge',
         jsonb_build_object('skillId', skill_id), jsonb_build_object('migrated', true), unlocked_at, unlocked_at
  FROM fresh
  ON CONFLICT (operation_key) DO NOTHING
  RETURNING operation_key
)
INSERT INTO player_skill_world_unlocks (player_id, skill_id, revealed_at, operation_key)
SELECT fresh.player_id, fresh.skill_id, fresh.unlocked_at, fresh.operation_key
FROM fresh
JOIN operations USING (operation_key);

ALTER TABLE player_dungeon_skills RENAME TO player_dungeon_skills_legacy;
COMMENT ON TABLE player_dungeon_skills_legacy IS
  'Retired: token skills now live in player_skill_world_unlocks / player_skill_ranks (migration 0908).';
