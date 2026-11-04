-- Class roster v2: the Hammer is a real weapon (the Paladin weapon), with its own one-handed
-- melee family `hammer` instead of being a retired cosmetic look in the staff family.
--
-- The existing `hammer` item becomes that family's stock item in place (the Double Axe pattern of
-- 1216), so every owned copy, wherever it is, is already the stock Hammer: instance ids, owners,
-- locations, slots, item levels, enchantments/metal, condition, inscriptions, kits and gear
-- scrolls are untouched. Only the item row and open/closed market listing snapshots, which
-- copied the staff family's weapon category and two-handed flag, change.
--
-- Idempotent: each write is keyed on the old values, so a second run changes nothing.

LOCK TABLE item_definitions, market_equipment_listings IN SHARE ROW EXCLUSIVE MODE;

UPDATE item_definitions
SET equipment_family_id = 'hammer',
    equipment_role = 'stock',
    updated_at = now()
WHERE item_id = 'hammer'
  AND (equipment_family_id IS DISTINCT FROM 'hammer' OR equipment_role IS DISTINCT FROM 'stock');

UPDATE market_equipment_listings
SET presentation_snapshot = jsonb_set(
      jsonb_set(presentation_snapshot, '{derivedStats,weaponCategory}', '"hammer"'::jsonb),
      '{derivedStats,twoHanded}', 'false'::jsonb
    )
WHERE presentation_snapshot->>'definitionId' = 'hammer'
  AND jsonb_typeof(presentation_snapshot->'derivedStats') = 'object'
  AND presentation_snapshot->'derivedStats'->>'weaponCategory' IS DISTINCT FROM 'hammer';
