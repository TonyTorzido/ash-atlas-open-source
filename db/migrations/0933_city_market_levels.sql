-- War for cities and kingdoms, part B3: City Market levels and City Tower slots.
--
-- A City Market's city_structures tier is its level, 1 to 10, raised through
-- the facility upgrade. Every other structure keeps its previous tier range
-- (Warehouse and Monument 1-3, the rest 1). Each Market level opens one City
-- Tower slot; the cap is enforced by the City Tower upgrade, not here.

ALTER TABLE city_structures DROP CONSTRAINT IF EXISTS city_structures_tier_check;
ALTER TABLE city_structures
  ADD CONSTRAINT city_structures_tier_check CHECK (
    tier BETWEEN 1 AND CASE WHEN structure_type = 'market' THEN 10 ELSE 3 END
  );

ALTER TABLE city_structures DROP CONSTRAINT IF EXISTS city_structures_civic_tier_check;
ALTER TABLE city_structures
  ADD CONSTRAINT city_structures_civic_tier_check CHECK (
    (structure_type IN ('oil_well', 'quartz_hut', 'cistern_warrens', 'salon', 'city_kennel',
      'barracks', 'armory', 'demolition_factory', 'siege_workshop', 'powder_works') AND tier = 1)
    OR (structure_type = 'market' AND tier BETWEEN 1 AND 10)
    OR (structure_type = 'monument' AND tier BETWEEN 1 AND 3)
    OR structure_type NOT IN ('market', 'oil_well', 'quartz_hut', 'cistern_warrens', 'salon', 'city_kennel',
      'barracks', 'armory', 'demolition_factory', 'siege_workshop', 'powder_works', 'monument')
  );

-- Market upgrades record their material spend per level like Warehouse tiers.
ALTER TABLE city_structure_material_spend DROP CONSTRAINT IF EXISTS city_structure_material_spend_tier_check;
ALTER TABLE city_structure_material_spend
  ADD CONSTRAINT city_structure_material_spend_tier_check CHECK (tier BETWEEN 1 AND 10);

COMMENT ON COLUMN city_structures.tier IS
  'Structure tier; for a City Market this is its level (1-10), one City Tower slot per level.';
