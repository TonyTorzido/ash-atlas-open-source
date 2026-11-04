-- Universal Manor decorations have no inventory custody. Keep the placement
-- row durable, but detach the legacy starter bed from normal item holdings.
ALTER TABLE manor_decoration_placements
  ALTER COLUMN item_id DROP NOT NULL,
  ALTER COLUMN item_variant DROP NOT NULL;

UPDATE manor_decoration_placements
SET definition_id = 'simple_double_bed',
    item_id = NULL,
    item_variant = NULL
WHERE definition_id = 'decoration';
