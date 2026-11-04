-- Background Population V2 preparation must leave combat profiles unclaimed.
-- Preserve killed history and every player-authoritative profile.

UPDATE generated_world_mobs
SET combat_level = NULL,
    combat_tier = NULL,
    combat_balance_version = NULL,
    combat_profile_claimed_at = NULL,
    combat_profile_source = NULL
WHERE combat_profile_source = 'background_fallback'
  AND combat_level = 0
  AND killed_at IS NULL
  AND NOT population_v2_suppressed;
