ALTER TABLE flags
  ADD COLUMN IF NOT EXISTS atlas_shrine_slot_number smallint;

ALTER TABLE flags
  DROP CONSTRAINT IF EXISTS flags_atlas_shrine_slot_number_range;
ALTER TABLE flags
  ADD CONSTRAINT flags_atlas_shrine_slot_number_range
  CHECK (
    atlas_shrine_slot_number IS NULL
    OR atlas_shrine_slot_number BETWEEN 1 AND 25
  );

ALTER TABLE flags
  DROP CONSTRAINT IF EXISTS flags_atlas_shrine_slot_scope;
ALTER TABLE flags
  ADD CONSTRAINT flags_atlas_shrine_slot_scope
  CHECK (
    atlas_shrine_slot_number IS NULL
    OR (
      control_type = 'personal'
      AND city_id IS NULL
      AND kingdom_id IS NULL
      AND reinforcement_level = 2
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS flags_active_atlas_shrine_owner_slot_unique
  ON flags (owner_id, atlas_shrine_slot_number)
  WHERE atlas_shrine_slot_number IS NOT NULL;

INSERT INTO player_atlas_shrine_progression (player_id, unlocked_slots)
SELECT owner_id, LEAST(count(*)::integer, 25)::smallint
FROM flags
WHERE control_type = 'personal'
  AND city_id IS NULL
  AND kingdom_id IS NULL
  AND reinforcement_level = 2
GROUP BY owner_id
ON CONFLICT (player_id) DO UPDATE
SET unlocked_slots = GREATEST(
  player_atlas_shrine_progression.unlocked_slots,
  EXCLUDED.unlocked_slots
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM flags
    WHERE control_type = 'personal'
      AND city_id IS NULL
      AND kingdom_id IS NULL
      AND reinforcement_level = 2
    GROUP BY owner_id
    HAVING count(*) > 25
  ) THEN
    RAISE EXCEPTION 'Atlas Shrine backfill cannot assign more than 25 slots to one player';
  END IF;
END
$$;

WITH missing AS (
  SELECT
    flag.id,
    flag.owner_id,
    row_number() OVER (
      PARTITION BY flag.owner_id
      ORDER BY flag.reinforced_at NULLS LAST, flag.created_at, flag.id
    ) AS missing_ordinal
  FROM flags flag
  WHERE flag.control_type = 'personal'
    AND flag.city_id IS NULL
    AND flag.kingdom_id IS NULL
    AND flag.reinforcement_level = 2
    AND flag.atlas_shrine_slot_number IS NULL
),
available AS (
  SELECT
    progression.player_id AS owner_id,
    slot.slot_number,
    row_number() OVER (
      PARTITION BY progression.player_id
      ORDER BY slot.slot_number
    ) AS available_ordinal
  FROM player_atlas_shrine_progression progression
  CROSS JOIN LATERAL generate_series(
    1,
    progression.unlocked_slots
  ) AS slot(slot_number)
  WHERE NOT EXISTS (
    SELECT 1
    FROM flags occupied
    WHERE occupied.owner_id = progression.player_id
      AND occupied.control_type = 'personal'
      AND occupied.city_id IS NULL
      AND occupied.kingdom_id IS NULL
      AND occupied.reinforcement_level = 2
      AND occupied.atlas_shrine_slot_number = slot.slot_number
  )
)
UPDATE flags flag
SET atlas_shrine_slot_number = available.slot_number
FROM missing
JOIN available
  ON available.owner_id = missing.owner_id
 AND available.available_ordinal = missing.missing_ordinal
WHERE flag.id = missing.id;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM flags
    WHERE control_type = 'personal'
      AND city_id IS NULL
      AND kingdom_id IS NULL
      AND reinforcement_level = 2
      AND atlas_shrine_slot_number IS NULL
  ) THEN
    RAISE EXCEPTION 'Atlas Shrine backfill left an active shrine without a slot';
  END IF;
END
$$;

UPDATE flags flag
SET name = 'Atlas Shrine ' || flag.atlas_shrine_slot_number::text
FROM players player
WHERE player.id = flag.owner_id
  AND flag.control_type = 'personal'
  AND flag.city_id IS NULL
  AND flag.kingdom_id IS NULL
  AND flag.reinforcement_level = 2
  AND flag.atlas_shrine_slot_number IS NOT NULL
  AND (
    btrim(flag.name) = ''
    OR btrim(flag.name) ~ '^Flag [0-9]+$'
    OR btrim(flag.name) = 'Atlas Shrine'
    OR btrim(flag.name) = left(player.username, 25) || '''s Atlas Shrine'
  );
