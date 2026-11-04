ALTER TABLE flags
  ALTER COLUMN health DROP NOT NULL,
  ALTER COLUMN health DROP DEFAULT,
  ALTER COLUMN maximum_health DROP NOT NULL,
  ALTER COLUMN maximum_health DROP DEFAULT;

ALTER TABLE flags DROP CONSTRAINT IF EXISTS flags_health_valid;

UPDATE flags
SET health = CASE
      WHEN anchor_kind = 'flag' AND reinforcement_level = 1 THEN LEAST(COALESCE(health, 200), 200)
      ELSE NULL
    END,
    maximum_health = CASE
      WHEN anchor_kind = 'flag' AND reinforcement_level = 1 THEN 200
      ELSE NULL
    END,
    burning_started_at = CASE
      WHEN anchor_kind = 'flag' AND reinforcement_level = 1 THEN burning_started_at
      ELSE NULL
    END,
    burning_until = CASE
      WHEN anchor_kind = 'flag' AND reinforcement_level = 1 THEN burning_until
      ELSE NULL
    END,
    burning_reason = CASE
      WHEN anchor_kind = 'flag' AND reinforcement_level = 1 THEN burning_reason
      ELSE NULL
    END;

SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE flags ADD CONSTRAINT flags_health_valid CHECK (
  (
    anchor_kind = 'flag' AND reinforcement_level = 1
    AND health IS NOT NULL
    AND maximum_health IS NOT NULL
    AND health BETWEEN 0 AND maximum_health
    AND maximum_health = 200
  )
  OR
  (
    NOT (anchor_kind = 'flag' AND reinforcement_level = 1)
    AND health IS NULL
    AND maximum_health IS NULL
  )
);

COMMENT ON COLUMN flags.health IS
  'Current durability for Stone Flags only; NULL for base flags, buoys, and Atlas Shrines.';
COMMENT ON COLUMN flags.maximum_health IS
  'Maximum durability for Stone Flags only; NULL for base flags, buoys, and Atlas Shrines.';
