BEGIN;

-- Water travel phase A (docs/design/WATER_GAME_PLAN.md).
-- afloat is server-set: true while the player is on a raft (ocean or lake).
-- Raft launches are paid through inventory_operations
-- (operation_key raft-launch:<player>:<request>), so no ledger table is needed.
-- Existing players start on land; anyone standing on water is set afloat for
-- free the next time they log in.

ALTER TABLE players
  ADD COLUMN IF NOT EXISTS afloat boolean NOT NULL DEFAULT false;

COMMIT;
