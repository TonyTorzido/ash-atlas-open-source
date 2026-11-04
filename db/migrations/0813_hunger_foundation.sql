-- Hunger foundation: durable authoritative current hunger and extensible base capacity.
-- Ordinary gameplay writes currently clamp current hunger to 0..2,000 in the server
-- persistence path. The database intentionally permits current hunger above capacity
-- so a future explicit saturation/overflow rule does not require a schema redesign.

ALTER TABLE players
  ADD COLUMN IF NOT EXISTS hunger integer NOT NULL DEFAULT 2000,
  ADD COLUMN IF NOT EXISTS hunger_base_capacity integer NOT NULL DEFAULT 2000;

-- Explicitly backfill every existing row. The migration ledger makes a second
-- run a no-op, so a later gameplay value is not overwritten by retrying it.
UPDATE players
SET hunger = 2000,
    hunger_base_capacity = 2000;

ALTER TABLE players
  ALTER COLUMN hunger SET DEFAULT 2000,
  ALTER COLUMN hunger SET NOT NULL,
  ALTER COLUMN hunger_base_capacity SET DEFAULT 2000,
  ALTER COLUMN hunger_base_capacity SET NOT NULL,
  DROP CONSTRAINT IF EXISTS players_hunger_nonnegative,
  ADD CONSTRAINT players_hunger_nonnegative CHECK (hunger >= 0),
  DROP CONSTRAINT IF EXISTS players_hunger_base_capacity_minimum,
  ADD CONSTRAINT players_hunger_base_capacity_minimum CHECK (hunger_base_capacity >= 2000);
