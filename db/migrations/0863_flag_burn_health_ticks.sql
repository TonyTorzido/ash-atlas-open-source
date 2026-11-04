-- Record an immutable damage budget and cumulative cursor on the existing
-- durable burn. Health remains authoritative on flags; no retained HP changes
-- during this upgrade. Existing burns begin accruing new damage from upgrade.
ALTER TABLE flag_burn_operations
  ADD COLUMN burn_start_health smallint CHECK (burn_start_health >= 0),
  ADD COLUMN burn_damage_applied smallint NOT NULL DEFAULT 0
    CHECK (burn_damage_applied >= 0);

UPDATE flag_burn_operations operation
SET burn_start_health=flag.health,
    burn_damage_applied=FLOOR(flag.health * GREATEST(0, LEAST(1,
      1 - CASE WHEN operation.paused_at IS NOT NULL
        THEN operation.remaining_duration_ms
        ELSE GREATEST(0, EXTRACT(EPOCH FROM (operation.completes_at-clock_timestamp()))*1000)
      END / operation.burn_duration_ms::numeric
    )))::smallint
FROM flags flag
WHERE operation.flag_id=flag.id AND operation.status='active'
  AND operation.source_kind IN ('player','developer_test') AND flag.health IS NOT NULL;

COMMENT ON COLUMN flag_burn_operations.burn_start_health IS
  'HP budget captured at ignition; gradual burn damage spans the authored active burn duration.';
COMMENT ON COLUMN flag_burn_operations.burn_damage_applied IS
  'Cumulative elapsed-time burn damage already accounted for; updated atomically with flag HP.';
