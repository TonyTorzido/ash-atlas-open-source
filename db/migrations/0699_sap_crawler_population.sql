-- Add Sap Crawlers to the existing grouped Population V2 mob contracts.

ALTER TABLE generated_world_mobs
  DROP CONSTRAINT generated_world_mobs_mob_archetype_check,
  DROP CONSTRAINT generated_world_mobs_check1,
  ADD CONSTRAINT generated_world_mobs_mob_archetype_check
    CHECK (mob_archetype IN ('deer', 'wolf', 'ogre', 'sap_crawler')),
  ADD CONSTRAINT generated_world_mobs_group_shape_check CHECK (
    (mob_archetype IN ('wolf', 'sap_crawler') AND pack_id IS NOT NULL)
    OR (mob_archetype IN ('deer', 'ogre') AND pack_id IS NULL)
  );

ALTER TABLE population_spawn_slots_v2
  DROP CONSTRAINT population_spawn_slots_v2_entity_kind_check,
  DROP CONSTRAINT population_spawn_slots_v2_check,
  ADD CONSTRAINT population_spawn_slots_v2_entity_kind_check
    CHECK (entity_kind IN (
      'tree', 'deer', 'wolf', 'ogre', 'sap_crawler', 'stone'
    )),
  ADD CONSTRAINT population_spawn_slots_v2_entity_shape_check CHECK (
    (entity_kind IN ('wolf', 'sap_crawler')
      AND encounter_id IS NOT NULL
      AND pack_id IS NOT NULL
      AND pack_member_index IS NOT NULL)
    OR
    (entity_kind IN ('deer', 'ogre')
      AND encounter_id IS NOT NULL
      AND pack_id IS NULL
      AND pack_member_index IS NULL)
    OR
    (entity_kind IN ('tree', 'stone')
      AND encounter_id IS NULL
      AND pack_id IS NULL
      AND pack_member_index IS NULL)
  );

COMMENT ON TABLE generated_world_mobs IS
  'Durable shared open-world Deer, Wolf-pack, Ogre, and Sap Crawler group bodies.';
