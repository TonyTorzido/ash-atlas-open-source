-- Standardize infusion family names while preserving stable item and market identities.
WITH standardized(item_id, display_name) AS (
  VALUES
    ('venomsteel_bar', 'Venom Bar'),
    ('venomsteel_core', 'Venom Core'),
    ('fire_feather', 'Ember Feather'),
    ('fire_bar', 'Ember Bar'),
    ('fire_core', 'Ember Core'),
    ('tempest_quill', 'Tempest Quill'),
    ('lightning_bar', 'Storm Bar'),
    ('lightning_core', 'Storm Core'),
    ('ice_feather', 'Frost Feather'),
    ('ice_bar', 'Frost Bar'),
    ('ice_core', 'Frost Core')
)
UPDATE item_definitions AS item
SET display_name = standardized.display_name,
    updated_at = now()
FROM standardized
WHERE item.item_id = standardized.item_id
  AND item.display_name IS DISTINCT FROM standardized.display_name;
