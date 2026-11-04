-- Mammoth Cut drops only from the Mammoth Patriarch world boss: Legendary (grade 5), so the
-- Kitchen's category recipes ask before cooking it (mob value pass, rare-find guard).
UPDATE item_definitions
SET rarity = 'legendary'
WHERE item_id = 'mammoth_cut' AND rarity <> 'legendary';
