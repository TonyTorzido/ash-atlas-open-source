-- Castle rubble. A Castle brought to 0 HP no longer ends its
-- kingdom: the kingdom stays active but ruined (castle_ruined_at), keeping
-- its name, members, flags and treasury. While ruined its perks give nothing
-- and members cannot build; the leader either rebuilds the Castle for the
-- founding cost (clearing castle_ruined_at) or, 7 days after the ruin,
-- disbands the kingdom through the ordinary dissolve and territory collapse.

ALTER TABLE kingdoms
  ADD COLUMN IF NOT EXISTS castle_ruined_at timestamptz NULL;

COMMENT ON COLUMN kingdoms.castle_ruined_at IS
  'When the Castle fell to rubble; NULL while it stands. A ruined kingdom grants no perks and cannot build.';

-- Perk effects read this view, never kingdom_perk_selections directly: the
-- selections stay recorded through a ruin (the Kingdom panel still lists
-- them) and take effect again when the Castle is rebuilt.
CREATE OR REPLACE VIEW kingdom_perk_selections_in_effect AS
SELECT selection.kingdom_id, selection.perk_level, selection.perk_id,
       selection.selected_at, selection.activated_at, selection.active_until
FROM kingdom_perk_selections selection
JOIN kingdoms kingdom ON kingdom.id = selection.kingdom_id
WHERE kingdom.castle_ruined_at IS NULL;

COMMENT ON VIEW kingdom_perk_selections_in_effect IS
  'Perk selections of kingdoms whose Castle stands; every perk effect reads this view.';

ALTER TABLE kingdom_treasury_ledger
  DROP CONSTRAINT IF EXISTS kingdom_treasury_ledger_source_valid;
ALTER TABLE kingdom_treasury_ledger
  ADD CONSTRAINT kingdom_treasury_ledger_source_valid CHECK (
    source_type IN (
      'brick_deposit', 'kingdom_structure_build', 'brick_furnace_upgrade', 'brick_furnace_package',
      'war_surrender_transfer', 'war_surrender_destroyed', 'war_death_loss',
      'kingdom_perk_choose', 'kingdom_perk_change',
      'command_board_upgrade', 'war_structure_build',
      'kingdom_perk_payout',
      'kingdom_structure_downgrade',
      'castle_rebuild'
    )
  );
