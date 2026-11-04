ALTER TABLE player_package_items
  DROP CONSTRAINT IF EXISTS player_package_items_item_kind_check,
  ALTER COLUMN canonical_item_id DROP NOT NULL;

ALTER TABLE player_package_items
  ADD CONSTRAINT player_package_items_item_kind_check
    CHECK (item_kind IN (
      'resource', 'consumable', 'equipment', 'gold', 'city_coins'
    )),
  ADD CONSTRAINT player_package_items_asset_shape_check
    CHECK (
      (
        item_kind IN ('resource', 'consumable', 'equipment')
        AND canonical_item_id IS NOT NULL
      )
      OR (
        item_kind IN ('gold', 'city_coins')
        AND canonical_item_id IS NULL
        AND variant IS NULL
      )
    );

CREATE UNIQUE INDEX item_definitions_package_kind_idx
  ON item_definitions (item_id, category);
ALTER TABLE player_package_items
  ADD CONSTRAINT player_package_items_physical_kind_fkey
  FOREIGN KEY (canonical_item_id, item_kind)
  REFERENCES item_definitions(item_id, category)
  ON DELETE RESTRICT;

DROP INDEX player_package_items_identity_idx;
CREATE UNIQUE INDEX player_package_items_identity_idx
  ON player_package_items (
    package_id,
    item_kind,
    COALESCE(canonical_item_id, item_kind),
    COALESCE(variant, '')
  );

ALTER TABLE city_coin_ledger
  DROP CONSTRAINT IF EXISTS city_coin_ledger_entry_type_check;
ALTER TABLE city_coin_ledger
  ADD CONSTRAINT city_coin_ledger_entry_type_check
  CHECK (entry_type IN (
    'combat_contribution',
    'development_grant',
    'package_grant',
    'construction_spend'
  ));
