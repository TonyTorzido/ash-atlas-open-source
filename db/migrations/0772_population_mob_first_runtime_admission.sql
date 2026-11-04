-- Population V2 mobs are phase-gated only until their first runtime lease.
-- Existing ready mobs are grandfathered so rollout cannot remove live actors.
ALTER TABLE population_entity_state_v2
  ADD COLUMN first_runtime_admitted_at timestamptz NULL;

UPDATE population_entity_state_v2 AS state
SET first_runtime_admitted_at = clock_timestamp()
FROM population_spawn_slots_v2 AS slot
WHERE slot.entity_id = state.entity_id
  AND state.state = 'ready'
  AND slot.entity_kind NOT IN ('tree', 'stone', 'coal', 'iron');

COMMENT ON COLUMN population_entity_state_v2.first_runtime_admitted_at IS
  'First successful Population V2 mob runtime admission. NULL keeps new mobs eligible for their configured mechanical world phase; admitted mobs are never phase-gated again.';
