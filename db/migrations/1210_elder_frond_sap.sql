-- Elder Ferns (packages/shared/src/givingTrees.ts) are tapped for 1 Frond Sap (item balsam_resin)
-- and refill 5 hours after each tap. sap_harvested_at is the last tap, per fern; NULL means the
-- fern has never been tapped. Only Elder Fern rows ever get a value. The item keeps its id; only
-- the player-facing name changes. Idempotent: a second run adds nothing and renames nothing.

ALTER TABLE collectible_nodes
  ADD COLUMN IF NOT EXISTS sap_harvested_at timestamptz NULL;

UPDATE item_definitions
SET display_name = 'Frond Sap', updated_at = now()
WHERE item_id = 'balsam_resin'
  AND display_name IS DISTINCT FROM 'Frond Sap';
