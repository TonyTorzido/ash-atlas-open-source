-- Route legendary-bird Flag attacks through the durable warfare burn ledger.
-- Player burns keep their burner identity; system burns retain the encounter
-- identity instead of inventing a player actor.

ALTER TABLE flag_burn_operations
  ALTER COLUMN burner_player_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS source_kind text NOT NULL DEFAULT 'player',
  ADD COLUMN IF NOT EXISTS legendary_event_id uuid;

-- The original inline burner/victim check assumed every burn had a player
-- actor. Replace it with a source-aware invariant while preserving that rule
-- for ordinary player burns.
DO $$
DECLARE
  constraint_row record;
BEGIN
  FOR constraint_row IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'flag_burn_operations'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%burner_player_id%'
      AND pg_get_constraintdef(oid) ILIKE '%victim_player_id%'
  LOOP
    EXECUTE format(
      'ALTER TABLE flag_burn_operations DROP CONSTRAINT %I',
      constraint_row.conname
    );
  END LOOP;
END $$;

ALTER TABLE flag_burn_operations
  DROP CONSTRAINT IF EXISTS flag_burn_operations_source_check;

ALTER TABLE flag_burn_operations
  ADD CONSTRAINT flag_burn_operations_source_check CHECK (
    (
      source_kind = 'player'
      AND burner_player_id IS NOT NULL
      AND legendary_event_id IS NULL
      AND burner_player_id <> victim_player_id
    )
    OR
    (
      source_kind = 'legendary_bird'
      AND burner_player_id IS NULL
      AND legendary_event_id IS NOT NULL
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS flag_burn_operations_legendary_event_unique
  ON flag_burn_operations (legendary_event_id)
  WHERE legendary_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS flag_burn_operations_source_idx
  ON flag_burn_operations (source_kind, status, completes_at);

-- Migrate retained event-marker burns that are still within their encounter
-- window. The event table deliberately remains independent of this ledger:
-- deleting a Flag must not erase the terminal operation record while the
-- canonical burn deletion path is completing it.
INSERT INTO flag_burn_operations (
  burner_player_id,victim_player_id,flag_id,request_id,flag_name,
  flag_lat,flag_lon,notice_message,started_at,completes_at,
  reinforcement_level,burn_duration_ms,damage_cycle_id,remaining_duration_ms,
  source_kind,legendary_event_id
)
SELECT
  NULL,event.owner_player_id,event.flag_id,event.event_id::text,flag.name,
  flag.lat,flag.lon,'A legendary bird is burning this Flag.',
  flag.burning_started_at,flag.burning_until,
  flag.reinforcement_level,79200000,
  COALESCE(flag.damage_cycle_id,gen_random_uuid()),
  GREATEST(
    0,
    FLOOR(EXTRACT(EPOCH FROM (flag.burning_until-clock_timestamp()))*1000)
  )::bigint,
  'legendary_bird',event.event_id
FROM legendary_bird_events event
JOIN flags flag ON flag.id=event.flag_id
WHERE event.status IN ('pending','active','completed')
  AND event.expires_at>clock_timestamp()
  AND flag.burning_reason='legendary_event'
  AND flag.burning_started_at IS NOT NULL
  AND flag.burning_until IS NOT NULL
  AND flag.reinforcement_level IN (1,3)
ON CONFLICT DO NOTHING;

UPDATE flags flag
SET health = LEAST(
      flag.health,
      CASE operation.reinforcement_level
        WHEN 1 THEN 100
        WHEN 3 THEN 1350
      END
    ),
    damage_cycle_id = COALESCE(flag.damage_cycle_id,operation.damage_cycle_id),
    burning_started_at = operation.started_at,
    burning_until = operation.completes_at,
    burning_reason = 'flag_burn'
FROM flag_burn_operations operation
WHERE operation.flag_id=flag.id
  AND operation.source_kind='legendary_bird'
  AND operation.status='active'
  AND flag.burning_reason='legendary_event';

COMMENT ON COLUMN flag_burn_operations.source_kind IS
  'Burn source: player for ordinary warfare, or legendary_bird for a canonical encounter burn.';
COMMENT ON COLUMN flag_burn_operations.legendary_event_id IS
  'Encounter identity for a legendary_bird burn; NULL for player burns.';
COMMENT ON TABLE flag_burn_operations IS
  'Durable soft and bastion Flag burning operations. The operation is authoritative; flags.burning_* is a presentation mirror.';
