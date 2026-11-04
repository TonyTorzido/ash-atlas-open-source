-- War for cities and kingdoms, part A3: war-death losses.
--
-- A player killed by a member of a side at war with one of their sides
-- loses 9% of their carried Bricks (rounded down, destroyed). When the
-- victim's kingdom is the side at war, its treasury loses 115 Bricks, or
-- 1,150 for the leader, floored at an empty treasury. One row per death
-- (the death's operation key), so a replayed death never charges twice.

CREATE TABLE IF NOT EXISTS organization_war_death_losses (
  operation_key text PRIMARY KEY CHECK (length(operation_key) BETWEEN 1 AND 240),
  war_id uuid NOT NULL REFERENCES organization_wars(war_id) ON DELETE RESTRICT,
  victim_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  killer_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  victim_kingdom_id uuid NULL REFERENCES kingdoms(id) ON DELETE RESTRICT,
  victim_was_leader boolean NOT NULL,
  carried_before bigint NOT NULL CHECK (carried_before >= 0),
  carried_lost bigint NOT NULL,
  treasury_lost integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_war_death_losses_players_distinct CHECK (victim_player_id <> killer_player_id),
  CONSTRAINT organization_war_death_losses_carried_valid CHECK (carried_lost = carried_before * 9 / 100),
  CONSTRAINT organization_war_death_losses_treasury_valid CHECK (
    treasury_lost >= 0
    AND treasury_lost <= CASE WHEN victim_was_leader THEN 1150 ELSE 115 END
    AND (victim_kingdom_id IS NOT NULL OR (treasury_lost = 0 AND NOT victim_was_leader))
  )
);

CREATE INDEX IF NOT EXISTS organization_war_death_losses_war_idx
  ON organization_war_death_losses (war_id, created_at DESC);

DROP TRIGGER IF EXISTS organization_war_death_losses_append_only ON organization_war_death_losses;
CREATE TRIGGER organization_war_death_losses_append_only
BEFORE UPDATE OR DELETE ON organization_war_death_losses
FOR EACH ROW EXECUTE FUNCTION prevent_kingdom_ledger_mutation();

ALTER TABLE kingdom_treasury_ledger
  DROP CONSTRAINT IF EXISTS kingdom_treasury_ledger_source_valid;
ALTER TABLE kingdom_treasury_ledger
  ADD CONSTRAINT kingdom_treasury_ledger_source_valid CHECK (
    source_type IN (
      'brick_deposit', 'kingdom_structure_build', 'brick_furnace_upgrade', 'brick_furnace_package',
      'war_surrender_transfer', 'war_surrender_destroyed', 'war_death_loss'
    )
  );

COMMENT ON TABLE organization_war_death_losses IS
  'Append-only war-death losses, one per player death: carried Bricks destroyed and kingdom treasury Bricks lost.';
