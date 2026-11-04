-- Class roster v2, axe cleanup (docs/plans/class-roster-v2.md section 8).
--
-- 1. The Double Axe becomes the stock axe (the Warrior weapon). The plain Axe (training_axe) is
--    retired: its row stays only as an FK-safe tombstone for history (operations, journals,
--    events, chat), like training_heavy_chest (0760) and the old rings (1070).
-- 2. Every training_axe instance, wherever it is (inventory, equipped, Manor storage, market
--    escrow or collection, gift escrow, ground, destroyed), becomes a double_axe. Only the
--    definition changes: the instance id, owner, location, slot, item level (upgrades),
--    enchantment/metal, condition, inscription, protections, saved kits and gear scrolls stay.
--    Both items are the same axe family, weight and rarity, so stats and carry weight match.
-- 3. Ground drops, market listing snapshots, package/gift lines, keep policies and tagged shop
--    copies that name training_axe follow their instance.
-- 4. The chopping tools are Hatchets, so "axe" always means a weapon (ids unchanged).
--
-- Idempotent: every write is keyed on 'training_axe', so a second run changes nothing.

LOCK TABLE item_definitions, equipment_instances, world_equipment_drops,
  market_equipment_listings, player_package_items, player_gift_equipment_instances,
  player_item_keep_policies, shop_item_copies
  IN SHARE ROW EXCLUSIVE MODE;

-- Equipment never stacks, is never sold by merchants and is never a fungible market item, so a
-- training_axe in any of these places is an unknown state. Stop rather than guess.
DO $$
DECLARE
  offending text;
BEGIN
  SELECT string_agg(source, ', ') INTO offending FROM (
    SELECT 'player_inventory' AS source WHERE EXISTS (SELECT 1 FROM player_inventory WHERE resource_type = 'training_axe')
    UNION ALL SELECT 'manor_storage_stacks' WHERE EXISTS (SELECT 1 FROM manor_storage_stacks WHERE item_id = 'training_axe')
    UNION ALL SELECT 'manor_storage_overflow' WHERE EXISTS (SELECT 1 FROM manor_storage_overflow WHERE item_id = 'training_axe')
    UNION ALL SELECT 'city_warehouse_stacks' WHERE EXISTS (SELECT 1 FROM city_warehouse_stacks WHERE item_id = 'training_axe')
    UNION ALL SELECT 'world_item_drops' WHERE EXISTS (SELECT 1 FROM world_item_drops WHERE item_id = 'training_axe')
    UNION ALL SELECT 'market_orders' WHERE EXISTS (SELECT 1 FROM market_orders WHERE item_id = 'training_axe')
    UNION ALL SELECT 'market_order_escrows' WHERE EXISTS (SELECT 1 FROM market_order_escrows WHERE item_id = 'training_axe')
    UNION ALL SELECT 'market_collections' WHERE EXISTS (SELECT 1 FROM market_collections WHERE item_id = 'training_axe')
    UNION ALL SELECT 'wandering_merchant_stock' WHERE EXISTS (SELECT 1 FROM wandering_merchant_stock WHERE item_id = 'training_axe')
    UNION ALL SELECT 'goblin_market_stock' WHERE EXISTS (SELECT 1 FROM goblin_market_stock WHERE item_id = 'training_axe')
    UNION ALL SELECT 'glimmer_shop_catalog' WHERE EXISTS (SELECT 1 FROM glimmer_shop_catalog WHERE grant_item_id = 'training_axe')
  ) found;
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'training_axe found in unsupported places: %', offending;
  END IF;
END
$$;

UPDATE item_definitions
SET equipment_role = 'stock',
    updated_at = now()
WHERE item_id = 'double_axe'
  AND equipment_role IS DISTINCT FROM 'stock';

UPDATE item_definitions
SET display_name = 'Training Axe',
    market_tradable = false,
    market_fungible = false,
    equipment_role = 'special',
    updated_at = now()
WHERE item_id = 'training_axe'
  AND equipment_role IS DISTINCT FROM 'special';

UPDATE item_definitions
SET display_name = CASE item_id WHEN 'wooden_axe' THEN 'Wooden Hatchet' ELSE 'Stone Hatchet' END,
    updated_at = now()
WHERE item_id IN ('wooden_axe', 'stone_axe')
  AND display_name IN ('Wooden Axe', 'Stone Axe');

-- Manor Storage is retired behind a write guard; this conversion keeps those rows in place.
SELECT set_config('ash_atlas.manor_storage_recovery', '1', true);

UPDATE equipment_instances
SET definition_id = 'double_axe',
    metadata = metadata || jsonb_build_object('convertedFromDefinition', 'training_axe'),
    updated_at = now()
WHERE definition_id = 'training_axe';

SELECT set_config('ash_atlas.manor_storage_recovery', '', true);

UPDATE world_equipment_drops
SET item_id = 'double_axe'
WHERE item_id = 'training_axe';

UPDATE market_equipment_listings
SET presentation_snapshot = presentation_snapshot || jsonb_build_object(
      'definitionId', 'double_axe',
      'displayName', 'Double Axe',
      'artworkKey', 'double_axe'
    )
WHERE presentation_snapshot->>'definitionId' = 'training_axe';

-- Package and gift lines: a package that already has a Double Axe line takes the Axe line's
-- quantities and gift instances, then the Axe line goes; otherwise the line is renamed.
WITH pairs AS (
  SELECT axe.package_id, axe.line_number AS axe_line, dbl.line_number AS double_line,
         axe.original_quantity, axe.remaining_quantity
  FROM player_package_items axe
  JOIN player_package_items dbl
    ON dbl.package_id = axe.package_id
   AND dbl.item_kind = 'equipment'
   AND dbl.canonical_item_id = 'double_axe'
   AND COALESCE(dbl.variant, '') = COALESCE(axe.variant, '')
  WHERE axe.item_kind = 'equipment' AND axe.canonical_item_id = 'training_axe'
),
merged AS (
  UPDATE player_package_items line
  SET original_quantity = line.original_quantity + pairs.original_quantity,
      remaining_quantity = line.remaining_quantity + pairs.remaining_quantity
  FROM pairs
  WHERE line.package_id = pairs.package_id AND line.line_number = pairs.double_line
  RETURNING pairs.package_id, pairs.axe_line, pairs.double_line
)
UPDATE player_gift_equipment_instances gift
SET line_number = merged.double_line
FROM merged
WHERE gift.package_id = merged.package_id AND gift.line_number = merged.axe_line;

DELETE FROM player_package_items axe
USING player_package_items dbl
WHERE axe.item_kind = 'equipment' AND axe.canonical_item_id = 'training_axe'
  AND dbl.package_id = axe.package_id
  AND dbl.item_kind = 'equipment'
  AND dbl.canonical_item_id = 'double_axe'
  AND COALESCE(dbl.variant, '') = COALESCE(axe.variant, '');

UPDATE player_package_items
SET canonical_item_id = 'double_axe'
WHERE item_kind = 'equipment' AND canonical_item_id = 'training_axe';

-- Keep policies: the higher keep count wins when a player had one for both items.
INSERT INTO player_item_keep_policies (player_id, item_id, variant, keep_quantity, revision, updated_at)
SELECT player_id, 'double_axe', variant, keep_quantity, revision, now()
FROM player_item_keep_policies
WHERE item_id = 'training_axe'
ON CONFLICT (player_id, item_id, variant) DO UPDATE SET
  keep_quantity = GREATEST(player_item_keep_policies.keep_quantity, EXCLUDED.keep_quantity),
  revision = player_item_keep_policies.revision + 1,
  updated_at = now();

DELETE FROM player_item_keep_policies WHERE item_id = 'training_axe';

UPDATE shop_item_copies
SET item_id = 'double_axe'
WHERE item_id = 'training_axe';
