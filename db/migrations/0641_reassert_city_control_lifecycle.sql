ALTER TABLE flags
  DROP CONSTRAINT IF EXISTS flags_control_type_valid,
  ADD CONSTRAINT flags_control_type_valid
    CHECK (control_type IN ('personal', 'city', 'city_seat', 'kingdom', 'kingdom_seat')),
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
      AND original_owner_player_id IS NOT NULL
      AND contributed_by_player_id IS NOT NULL
    )
    OR
    (
      control_type IN ('kingdom', 'kingdom_seat')
      AND city_id IS NULL
      AND kingdom_id IS NOT NULL
      AND kingdom_affiliated_at IS NOT NULL
      AND original_owner_player_id IS NOT NULL
    )
  );
