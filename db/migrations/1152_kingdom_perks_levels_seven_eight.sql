-- Kingdom perks for levels 7 and 8. Level 9 still offers none,
-- so the per-level perk id list keeps rejecting any perk on level 9.
--
-- Level 7 perks pay out when a member receives a ring from a Legendary mob;
-- the treasury payouts (Mortar Guard Bricks, Prism Knights
-- Crystal) go through kingdom_treasury_ledger under the ring grant's
-- operation key, so a replayed reward can never pay twice.
--
-- 1150 already widened the perk_level ranges of kingdom_perk_selections and
-- kingdom_perk_operations to 2..9.

ALTER TABLE kingdom_perk_selections DROP CONSTRAINT IF EXISTS kingdom_perk_selections_perk_valid;
ALTER TABLE kingdom_perk_selections
  ADD CONSTRAINT kingdom_perk_selections_perk_valid CHECK (
    (perk_level = 2 AND perk_id IN ('verdant_surge', 'picket_lines', 'boundary_writ', 'reserved_game'))
    OR (perk_level = 3 AND perk_id IN ('beacon_wardens', 'braced_foundations', 'grand_masonry', 'forward_sappers'))
    OR (perk_level = 4 AND perk_id IN ('skyward_stonework', 'sworn_ramparts', 'gilded_trim', 'warded_monuments'))
    OR (perk_level = 5 AND perk_id IN ('unyielding_assault', 'picked_legion', 'hearth_ground', 'labor_corps'))
    OR (perk_level = 6 AND perk_id IN ('breach_company', 'the_spearhead', 'the_watchfires', 'caravan_guild'))
    OR (perk_level = 7 AND perk_id IN ('arcane_reavers', 'mortar_guard', 'prism_knights', 'cache_hunters'))
    OR (perk_level = 8 AND perk_id IN ('treacherous_ground', 'far_renown', 'restless_herds', 'prism_holdings'))
  );

ALTER TABLE kingdom_treasury_ledger
  DROP CONSTRAINT IF EXISTS kingdom_treasury_ledger_source_valid;
ALTER TABLE kingdom_treasury_ledger
  ADD CONSTRAINT kingdom_treasury_ledger_source_valid CHECK (
    source_type IN (
      'brick_deposit', 'kingdom_structure_build', 'brick_furnace_upgrade', 'brick_furnace_package',
      'war_surrender_transfer', 'war_surrender_destroyed', 'war_death_loss',
      'kingdom_perk_choose', 'kingdom_perk_change',
      'command_board_upgrade', 'war_structure_build',
      'kingdom_perk_payout'
    )
  );
