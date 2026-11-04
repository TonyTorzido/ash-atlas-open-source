ALTER TABLE item_definitions
  ADD COLUMN rarity text NOT NULL DEFAULT 'common';

ALTER TABLE item_definitions
  ADD CONSTRAINT item_definitions_rarity_check CHECK (
    rarity IN ('common', 'uncommon', 'rare', 'epic', 'legendary')
  );

UPDATE item_definitions
SET rarity = CASE item_id
  WHEN 'balsam_resin' THEN 'uncommon'
  WHEN 'jellyfish_venom' THEN 'rare'
  WHEN 'atlas_shrine_shard' THEN 'rare'
  ELSE rarity
END
WHERE item_id IN ('balsam_resin', 'jellyfish_venom', 'atlas_shrine_shard');
