-- Giving Tree saplings, rules (docs/giving-trees.md): grown player trees can be chopped, and the
-- lifecycle sweep reads one indexed due_at instead of scanning. Forward-only and idempotent.
--   state_revision  bumps when a tree is chopped, like a wild tree's life revision (harvest keys).
--   due_at          the next instant a growing sapling changes: tend due (it turns sick and stops
--                   healing), death or maturity, whichever is first. NULL once settled.
--   chopped         a grown tree felled for Wood; permanent, it never respawns.

ALTER TABLE player_saplings
  ADD COLUMN IF NOT EXISTS state_revision BIGINT NOT NULL DEFAULT 0 CHECK (state_revision >= 0),
  ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS chopped_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS chopped_by_player_id TEXT NULL REFERENCES players(id) ON DELETE SET NULL;

ALTER TABLE player_saplings DROP CONSTRAINT IF EXISTS player_saplings_status_check;
ALTER TABLE player_saplings ADD CONSTRAINT player_saplings_status_check
  CHECK (status IN ('sapling', 'grown', 'dead', 'pulled', 'chopped'));
ALTER TABLE player_saplings DROP CONSTRAINT IF EXISTS player_saplings_chopped_check;
ALTER TABLE player_saplings ADD CONSTRAINT player_saplings_chopped_check
  CHECK (status <> 'chopped' OR chopped_at IS NOT NULL);

UPDATE player_saplings
   SET due_at = LEAST(last_tended_at + interval '1 day', death_at, mature_at)
 WHERE status = 'sapling' AND due_at IS NULL;

CREATE INDEX IF NOT EXISTS player_saplings_due_at_idx
  ON player_saplings (due_at) WHERE status = 'sapling' AND due_at IS NOT NULL;
