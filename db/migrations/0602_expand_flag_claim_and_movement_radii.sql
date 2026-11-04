UPDATE flags
SET claim_radius_m = 1000
WHERE claim_radius_m IS DISTINCT FROM 1000;

UPDATE players
SET move_leash_radius_m = 1250
WHERE move_leash_radius_m IS DISTINCT FROM 1250;

UPDATE flag_resource_visions
SET status = 'pending',
    radius_m = 1500,
    node_count = 0,
    water_highlight_count = 0,
    requested_at = now(),
    generated_at = NULL,
    last_error = NULL
WHERE radius_m IS DISTINCT FROM 1500;
