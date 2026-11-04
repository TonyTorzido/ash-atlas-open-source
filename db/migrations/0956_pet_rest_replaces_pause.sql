-- Every ended outing now goes home to rest; paused timers are gone. Pets that were paused (sent
-- home early or left at a dungeon door) become ready. Forward-only and idempotent.
UPDATE account_pet_whistles
SET paused_remaining_ms = NULL,
    updated_at = now()
WHERE paused_remaining_ms IS NOT NULL;
