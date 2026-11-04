ALTER TABLE cities
  ALTER COLUMN seat_flag_id DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS cities_seat_flag_id_fkey,
  ADD CONSTRAINT cities_seat_flag_id_fkey
    FOREIGN KEY (seat_flag_id) REFERENCES flags(id) ON DELETE SET NULL;

ALTER TABLE flags
  DROP CONSTRAINT IF EXISTS flags_control_state_valid,
  ADD CONSTRAINT flags_control_state_valid CHECK (
    (
      control_type = 'personal'
      AND city_id IS NULL
      AND kingdom_id IS NULL
      AND city_affiliated_at IS NULL
      AND kingdom_affiliated_at IS NULL
    )
    OR
    (
      control_type IN ('city', 'city_seat')
      AND city_id IS NOT NULL
      AND kingdom_id IS NULL
      AND city_affiliated_at IS NOT NULL
      AND city_affiliated_by_player_id IS NULL
      AND original_owner_player_id IS NULL
      AND contributed_by_player_id IS NULL
      AND original_personal_color IS NULL
    )
    OR
    (
      control_type IN ('kingdom', 'kingdom_seat')
      AND city_id IS NULL
      AND kingdom_id IS NOT NULL
      AND kingdom_affiliated_at IS NOT NULL
      AND original_owner_player_id IS NOT NULL
    )
  ) NOT VALID;

UPDATE flags flag
SET name = city.name || '''s Flag',
    city_affiliated_by_player_id = NULL,
    original_owner_player_id = NULL,
    contributed_by_player_id = NULL,
    original_personal_color = NULL
FROM cities city
WHERE flag.city_id = city.id
  AND flag.control_type IN ('city', 'city_seat');
