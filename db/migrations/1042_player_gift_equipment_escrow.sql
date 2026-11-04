-- Gifted equipment keeps its instance (level, enchantment, condition). While
-- the gift is unopened the instance stays owned by the sender in gift_escrow;
-- opening the gift transfers it to the recipient's inventory.
-- Constraints last defined in 0751 (location values) and 0829 (location fields).

ALTER TABLE equipment_instances
  ADD COLUMN gift_package_id uuid NULL REFERENCES player_packages(id) ON DELETE RESTRICT;

ALTER TABLE equipment_instances
  DROP CONSTRAINT equipment_instances_location_check,
  DROP CONSTRAINT equipment_instances_location_fields_check;
ALTER TABLE equipment_instances
  ADD CONSTRAINT equipment_instances_location_check CHECK (
    location IN (
      'inventory', 'equipped', 'manor_storage', 'market_escrow',
      'market_collection', 'world_drop', 'destroyed', 'gift_escrow'
    )
  ),
  ADD CONSTRAINT equipment_instances_location_fields_check CHECK (
    inventory_slot_index IS NULL AND (
      (location='equipped' AND equipped_slot IS NOT NULL AND manor_id IS NULL AND manor_slot_index IS NULL
        AND market_listing_id IS NULL AND market_collection_id IS NULL AND gift_package_id IS NULL)
      OR (location='inventory' AND equipped_slot IS NULL AND manor_id IS NULL AND manor_slot_index IS NULL
        AND market_listing_id IS NULL AND market_collection_id IS NULL AND gift_package_id IS NULL)
      OR (location='manor_storage' AND equipped_slot IS NULL AND manor_id IS NOT NULL AND manor_slot_index IS NOT NULL
        AND market_listing_id IS NULL AND market_collection_id IS NULL AND gift_package_id IS NULL)
      OR (location='market_escrow' AND equipped_slot IS NULL AND manor_id IS NULL AND manor_slot_index IS NULL
        AND market_listing_id IS NOT NULL AND market_collection_id IS NULL AND gift_package_id IS NULL)
      OR (location='market_collection' AND equipped_slot IS NULL AND manor_id IS NULL AND manor_slot_index IS NULL
        AND market_listing_id IS NOT NULL AND market_collection_id IS NOT NULL AND gift_package_id IS NULL)
      OR (location IN ('world_drop','destroyed') AND equipped_slot IS NULL AND manor_id IS NULL AND manor_slot_index IS NULL
        AND market_listing_id IS NULL AND market_collection_id IS NULL AND gift_package_id IS NULL)
      OR (location='gift_escrow' AND equipped_slot IS NULL AND manor_id IS NULL AND manor_slot_index IS NULL
        AND market_listing_id IS NULL AND market_collection_id IS NULL AND gift_package_id IS NOT NULL)
    )
  );

CREATE INDEX equipment_instances_gift_package_idx
  ON equipment_instances (gift_package_id)
  WHERE gift_package_id IS NOT NULL;

-- Exact instances behind a gift's equipment lines (line quantity = instance count).
CREATE TABLE player_gift_equipment_instances (
  instance_id uuid PRIMARY KEY REFERENCES equipment_instances(instance_id) ON DELETE RESTRICT,
  package_id uuid NOT NULL REFERENCES player_packages(id) ON DELETE RESTRICT,
  line_number smallint NOT NULL,
  delivered_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (package_id, line_number)
    REFERENCES player_package_items(package_id, line_number) ON DELETE RESTRICT
);
CREATE INDEX player_gift_equipment_instances_package_idx
  ON player_gift_equipment_instances (package_id, line_number);
