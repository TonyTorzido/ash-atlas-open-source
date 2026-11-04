-- Durable packed field state for the authoritative Siege Stay order. Existing
-- rows remain unchanged; only an explicit Stay command writes PACKED_FIELD.
ALTER TABLE military_units
  DROP CONSTRAINT IF EXISTS military_units_location_state_check,
  ADD CONSTRAINT military_units_location_state_check CHECK (
    location_state IN (
      'STATIONED_CITY','STATIONED_WAR_CAMP','PACKED_FIELD',
      'FOLLOWING_PLAYER','DEPLOYED_FIELD','RECOVERING'
    )
  );

ALTER TABLE military_unit_groups
  DROP CONSTRAINT IF EXISTS military_unit_groups_location_state_check,
  ADD CONSTRAINT military_unit_groups_location_state_check CHECK (
    location_state IN (
      'STATIONED_CITY','STATIONED_WAR_CAMP','PACKED_FIELD',
      'FOLLOWING_PLAYER','DEPLOYED_FIELD','RECOVERING'
    )
  );

ALTER TABLE military_units
  DROP CONSTRAINT IF EXISTS military_units_location_anchor_check,
  ADD CONSTRAINT military_units_location_anchor_check CHECK (
    (location_state = 'STATIONED_CITY' AND station_city_id IS NOT NULL AND war_camp_id IS NULL)
    OR (location_state = 'STATIONED_WAR_CAMP' AND war_camp_id IS NOT NULL AND station_city_id IS NULL)
    OR (location_state IN ('PACKED_FIELD','FOLLOWING_PLAYER','DEPLOYED_FIELD','RECOVERING'))
  );

ALTER TABLE military_unit_operations
  DROP CONSTRAINT IF EXISTS military_unit_operations_action_check;

ALTER TABLE military_unit_operations
  ADD CONSTRAINT military_unit_operations_action_check CHECK (action IN (
    'combine','split','load_bombers','build_war_camp','call_troops',
    'relocate_war_camp','remove_war_camp','follow','deploy','return','stop',
    'stay','repair_ballista','attack','developer_spawn','move_to_position'
  ));
