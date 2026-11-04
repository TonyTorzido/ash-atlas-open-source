-- Quick-slot layout settings and cumulative backpack capacity.
--
-- Both changes are additive. Existing six/eight-slot hotbar rows and formerly
-- equipped backpacks remain valid and are normalized by the runtime readers.
ALTER TABLE player_hotbar_settings
  ADD COLUMN IF NOT EXISTS row_count smallint NOT NULL DEFAULT 4
    CHECK (row_count BETWEEN 0 AND 5),
  ADD COLUMN IF NOT EXISTS row_positions jsonb NOT NULL DEFAULT '[0,21,42,63,84]'::jsonb;

ALTER TABLE player_hotbar_settings
  ALTER COLUMN slots SET DEFAULT '[
    {"slotId":"left-1","binding":null},
    {"slotId":"left-2","binding":null},
    {"slotId":"left-3","binding":null},
    {"slotId":"left-4","binding":null},
    {"slotId":"left-5","binding":null},
    {"slotId":"right-1","binding":null},
    {"slotId":"right-2","binding":null},
    {"slotId":"right-3","binding":null},
    {"slotId":"right-4","binding":null},
    {"slotId":"right-5","binding":null}
  ]'::jsonb;

-- A backpack contributes capacity while owned, regardless of whether it is in
-- carried inventory, a legacy equipped slot, or manor storage. Destroyed and
-- market/world escrow rows do not contribute. Carry weight remains governed by
-- player_inventory_weight_grams and therefore still excludes manor storage.
CREATE OR REPLACE FUNCTION player_inventory_maximum_grams(target_player_id text) RETURNS numeric
LANGUAGE sql VOLATILE AS $$
  SELECT capacity.base_capacity_grams::numeric+COALESCE((
    SELECT sum(level.capacity_bonus_grams) FROM player_backpack_instances backpack
    JOIN backpack_level_definitions level ON level.level=backpack.upgrade_level
    WHERE backpack.owner_player_id=target_player_id
      AND backpack.location IN ('inventory','equipped','manor_storage')
  ),0) FROM player_inventory_capacities capacity WHERE capacity.player_id=target_player_id;
$$;

COMMENT ON FUNCTION player_inventory_maximum_grams(text) IS
  'Player capacity is the base capacity plus every non-destroyed owned backpack, including manor storage.';
