-- Preserve historical station identities while admitting location-free upgrades.
ALTER TABLE equipment_upgrade_operations
  DROP CONSTRAINT equipment_upgrade_operations_authority_kind_check;
ALTER TABLE equipment_upgrade_operations
  ADD CONSTRAINT equipment_upgrade_operations_authority_kind_check
  CHECK (authority_kind IN ('legacy', 'city_facility', 'manor_smith', 'inventory'));
COMMENT ON COLUMN equipment_upgrade_operations.authority_kind IS
  'Upgrade intent identity: inventory uses authenticated ownership and transactional gold; historical station identities remain replayable.';
