ALTER TABLE population_river_water_suppressions_v1
  DROP CONSTRAINT population_river_water_suppressions_v1_entity_id_fkey;

COMMENT ON TABLE population_river_water_suppressions_v1 IS
  'Immutable exact river-surface-v1 conflicts retired from generated land population. Receipts outlive retired spawn slots; player-owned objects are never recorded here.';
