-- Water game phase C (docs/design/WATER_GAME_PLAN.md): pearl diving and whirlpools.
--
-- Pearl Beds, whirlpools and Drowned City sites are placed deterministically
-- from authoritative World water (apps/server/src/game/waterSites.ts), so they
-- need no placement table. One row per player and Pearl Bed records the last
-- dive: the 7 h cooldown is enforced on this row in the same transaction as the
-- pearl grant (inventory operation pearl-dive:<player>:<request>), and the
-- stored request id makes a replay return the first result instead of diving
-- again. Whirlpool trips pay 34 Shellback Plates through inventory_operations
-- (whirlpool:<player>:<request>) inside the travel transaction, so no ledger
-- table is needed. Forward-only and idempotent.

CREATE TABLE IF NOT EXISTS player_pearl_dives (
  player_id text NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  bed_id text NOT NULL CHECK (bed_id <> '' AND length(bed_id) <= 200),
  last_request_id text NOT NULL CHECK (last_request_id <> '' AND length(last_request_id) <= 128),
  last_dived_at timestamptz NOT NULL,
  last_pearls integer NOT NULL CHECK (last_pearls BETWEEN 1 AND 2),
  dive_count integer NOT NULL DEFAULT 1 CHECK (dive_count >= 1),
  PRIMARY KEY (player_id, bed_id)
);

COMMENT ON TABLE player_pearl_dives IS
  'Last Pearl Bed dive per player and bed; enforces the 7 hour dive cooldown and request replay.';
