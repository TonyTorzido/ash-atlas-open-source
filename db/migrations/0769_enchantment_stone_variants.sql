-- Add Onyx and Topaz without changing existing Enchantment Stone identities.

UPDATE item_definitions
SET supported_variants = ARRAY[
      'diamond', 'onyx', 'opal', 'amethyst', 'topaz', 'sapphire', 'ruby', 'emerald'
    ]::text[],
    updated_at = now()
WHERE item_id = 'enchantment_stone';
