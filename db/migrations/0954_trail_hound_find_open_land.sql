-- The Trail Hound's second ability is now Find Open Land (replacing Track Lair). Whistles that
-- already unlocked Track Lair keep the paid unlock under the new id. Forward-only and idempotent.
UPDATE account_pet_whistles
SET unlocked_abilities = array_replace(unlocked_abilities, 'track_lair', 'find_open_land'),
    updated_at = now()
WHERE 'track_lair' = ANY(unlocked_abilities);
