-- Cut Warrior over from Rage/reset actives to two resource-free class-skill slots.
-- Existing progression and equipment rows are intentionally untouched.

UPDATE player_class_loadouts AS loadout
SET reset_active_ids = ARRAY[NULL, NULL]::text[],
    normal_active_ids = CASE
      WHEN progress.mastery_rank >= 5
        THEN ARRAY['warrior_empowered_hit', 'warrior_anger_explosion']::text[]
      WHEN progress.mastery_rank >= 1
        THEN ARRAY['warrior_empowered_hit', NULL]::text[]
      ELSE ARRAY[NULL, NULL]::text[]
    END,
    passive_tier_ids = ARRAY[
      CASE WHEN progress.mastery_rank >= 1 THEN 'warrior_heavy_handed' END,
      CASE WHEN progress.mastery_rank >= 10 THEN 'warrior_relentless' END,
      CASE WHEN progress.mastery_rank >= 20 THEN 'warrior_desperate_fury' END
    ]::text[],
    revision = loadout.revision + 1
FROM player_class_progress AS progress
WHERE loadout.player_id = progress.player_id
  AND loadout.class_id = 'warrior'
  AND progress.class_id = 'warrior';

UPDATE player_class_resources AS resource
SET current_value = 0,
    reserved_value = 0,
    cooldown_ends_at = '{}'::jsonb,
    revision = resource.revision + 1
WHERE resource.class_id = 'warrior';

UPDATE player_class_runtime AS runtime
SET rage = 0,
    rage_reserved = 0,
    queued_ability_id = NULL,
    queued_target_entity_id = NULL,
    queued_at_tick = NULL,
    cooldown_ends_at = '{}'::jsonb,
    status_effects = COALESCE((
      SELECT jsonb_agg(effect)
      FROM jsonb_array_elements(runtime.status_effects) AS effect
      WHERE effect->>'sourceTechniqueId' IS NULL
         OR effect->>'sourceTechniqueId' NOT LIKE 'warrior_%'
    ), '[]'::jsonb),
    counters = '{}'::jsonb,
    combat_generation = combat_generation + 1,
    revision = runtime.revision + 1
FROM player_class_profiles AS profile
WHERE profile.player_id = runtime.player_id
  AND profile.active_class_id = 'warrior';
