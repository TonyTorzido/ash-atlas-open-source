-- Correct the damage model forward without rewriting 0863 or changing retained
-- HP. Existing active burns adopt the fixed half-max budget from this upgrade;
-- elapsed damage is marked accounted for, avoiding a retroactive damage spike.
ALTER TABLE flag_burn_operations
  ADD COLUMN burn_damage_budget smallint CHECK (burn_damage_budget >= 0);

UPDATE flag_burn_operations operation
SET burn_damage_budget=FLOOR(flag.maximum_health/2.0)::smallint,
    burn_damage_applied=FLOOR(FLOOR(flag.maximum_health/2.0) * GREATEST(0,LEAST(1,
      1-CASE WHEN operation.paused_at IS NOT NULL THEN operation.remaining_duration_ms
        ELSE GREATEST(0,EXTRACT(EPOCH FROM (operation.completes_at-clock_timestamp()))*1000)
      END/operation.burn_duration_ms::numeric
    )))::smallint
FROM flags flag
WHERE operation.flag_id=flag.id AND operation.status='active'
  AND operation.source_kind IN ('player','developer_test') AND flag.maximum_health IS NOT NULL;

COMMENT ON COLUMN flag_burn_operations.burn_damage_budget IS
  'Fixed half-max-HP budget at ignition, independent of ignition HP or later flat damage; consumed over burn_duration_ms of active time.';
COMMENT ON COLUMN flag_burn_operations.burn_start_health IS
  'Historical ignition HP snapshot only; not the burn damage budget.';
