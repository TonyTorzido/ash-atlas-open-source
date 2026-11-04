-- Progression Curve V3: preserve retained level progress while keeping XP history immutable.

LOCK TABLE player_progression_profiles IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM player_progression_profiles
    WHERE curve_version NOT IN (2, 3)
  ) THEN
    RAISE EXCEPTION 'Curve V3 migration encountered an unsupported retained curve version';
  END IF;
END
$$;

ALTER TABLE player_progression_profiles
  ALTER COLUMN curve_version SET DEFAULT 3,
  DROP CONSTRAINT IF EXISTS player_progression_profiles_total_xp_check;
ALTER TABLE player_progression_profiles
  ADD CONSTRAINT player_progression_profiles_total_xp_check
  CHECK (total_xp BETWEEN 0 AND 1000000);

ALTER TABLE xp_operations
  DROP CONSTRAINT IF EXISTS xp_operations_previous_xp_check,
  DROP CONSTRAINT IF EXISTS xp_operations_resulting_xp_check;
ALTER TABLE xp_operations
  ADD CONSTRAINT xp_operations_previous_xp_check
    CHECK (previous_xp BETWEEN 0 AND 1000000),
  ADD CONSTRAINT xp_operations_resulting_xp_check
    CHECK (resulting_xp BETWEEN 0 AND 1000000);

ALTER TABLE xp_events
  DROP CONSTRAINT IF EXISTS xp_events_resulting_xp_check;
ALTER TABLE xp_events
  ADD CONSTRAINT xp_events_resulting_xp_check
  CHECK (resulting_xp BETWEEN 0 AND 1000000);

CREATE TABLE IF NOT EXISTS character_xp_curve_adjustments (
  operation_key text PRIMARY KEY,
  player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  from_curve_version integer NOT NULL CHECK (from_curve_version > 0),
  to_curve_version integer NOT NULL CHECK (to_curve_version > from_curve_version),
  previous_xp integer NOT NULL CHECK (previous_xp BETWEEN 0 AND 1000000),
  resulting_xp integer NOT NULL CHECK (resulting_xp BETWEEN 0 AND 1000000),
  xp_delta integer NOT NULL,
  previous_level integer NOT NULL CHECK (previous_level BETWEEN 0 AND 25),
  resulting_level integer NOT NULL CHECK (resulting_level BETWEEN 0 AND 25),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (player_id, from_curve_version, to_curve_version),
  CHECK (resulting_xp = previous_xp + xp_delta)
);

CREATE TEMP TABLE progression_curve_v3_projection ON COMMIT DROP AS
WITH old_thresholds(level, threshold) AS (
  VALUES
    (0,0),(1,800),(2,2464),(3,5088),(4,8768),(5,13600),(6,19680),
    (7,27104),(8,35968),(9,46368),(10,58400),(11,72160),(12,87744),
    (13,105248),(14,124768),(15,146400),(16,170240),(17,196384),
    (18,224928),(19,255968),(20,289600),(21,325920),(22,365024),
    (23,407008),(24,451968),(25,500000)
),
new_thresholds(level, threshold) AS (
  VALUES
    (0,0),(1,7194),(2,15270),(3,24337),(4,34517),(5,45946),(6,58778),
    (7,73184),(8,89357),(9,107516),(10,127902),(11,150791),(12,176487),
    (13,205337),(14,237728),(15,274092),(16,314919),(17,360756),
    (18,412217),(19,469993),(20,534858),(21,607683),(22,689444),
    (23,781238),(24,884296),(25,1000000)
),
located AS (
  SELECT profile.player_id, profile.total_xp AS previous_xp, old.level,
         old.threshold AS old_threshold, old_next.threshold AS old_next_threshold,
         current_new.threshold AS new_threshold,
         new_next.threshold AS new_next_threshold
  FROM player_progression_profiles AS profile
  JOIN LATERAL (
    SELECT level, threshold
    FROM old_thresholds
    WHERE threshold <= profile.total_xp
    ORDER BY level DESC
    LIMIT 1
  ) AS old ON true
  LEFT JOIN old_thresholds AS old_next ON old_next.level = old.level + 1
  JOIN new_thresholds AS current_new ON current_new.level = old.level
  LEFT JOIN new_thresholds AS new_next ON new_next.level = old.level + 1
  WHERE profile.curve_version = 2
)
SELECT player_id, previous_xp, level AS previous_level, level AS resulting_level,
       CASE
         WHEN level = 25 THEN 1000000
         ELSE new_threshold + FLOOR(
           (
             2::numeric * (previous_xp - old_threshold) *
               (new_next_threshold - new_threshold) +
             (old_next_threshold - old_threshold)
           ) /
           (2::numeric * (old_next_threshold - old_threshold))
         )::integer
       END AS resulting_xp
FROM located;

INSERT INTO character_xp_curve_adjustments (
  operation_key, player_id, from_curve_version, to_curve_version,
  previous_xp, resulting_xp, xp_delta, previous_level, resulting_level
)
SELECT
  'progression-curve:v2-to-v3:' || player_id,
  player_id, 2, 3, previous_xp, resulting_xp, resulting_xp - previous_xp,
  previous_level, resulting_level
FROM progression_curve_v3_projection
ON CONFLICT (player_id, from_curve_version, to_curve_version) DO NOTHING;

UPDATE player_progression_profiles AS profile
SET total_xp = projection.resulting_xp,
    level = projection.resulting_level,
    curve_version = 3,
    persistence_version = profile.persistence_version + 1,
    updated_at = now()
FROM progression_curve_v3_projection AS projection
WHERE projection.player_id = profile.player_id
  AND profile.curve_version = 2;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM progression_curve_v3_projection AS projection
    JOIN player_progression_profiles AS profile USING (player_id)
    LEFT JOIN character_xp_curve_adjustments AS adjustment
      ON adjustment.player_id = profile.player_id
     AND adjustment.from_curve_version = 2
     AND adjustment.to_curve_version = 3
    WHERE profile.total_xp IS DISTINCT FROM projection.resulting_xp
       OR profile.level IS DISTINCT FROM projection.resulting_level
       OR profile.curve_version IS DISTINCT FROM 3
       OR adjustment.resulting_xp IS DISTINCT FROM projection.resulting_xp
  ) THEN
    RAISE EXCEPTION 'Curve V3 migration failed to preserve its profile and ledger projection';
  END IF;
END
$$;

COMMENT ON TABLE character_xp_curve_adjustments IS
  'Append-only ledger adjustments produced by deterministic character XP curve migrations.';
