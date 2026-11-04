-- Match the shared 1.5 kg equipment weight for the Model 3 armor variants.
UPDATE item_definitions
SET unit_weight_grams = 1500,
    updated_at = now()
WHERE item_id IN ('non-swag-cloth', 'non-swag-leather', 'non-swag-breastplate');
