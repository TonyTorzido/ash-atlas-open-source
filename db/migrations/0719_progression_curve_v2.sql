-- Reproject retained character levels onto Curve V2 without changing XP history.

ALTER TABLE player_progression_profiles
  ALTER COLUMN curve_version SET DEFAULT 2;

LOCK TABLE player_progression_profiles IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE progression_curve_v2_xp_guard AS
SELECT player_id, total_xp
FROM player_progression_profiles;

WITH projected AS (
  SELECT
    player_id,
    CASE
      WHEN total_xp >= 500000 THEN 25
      WHEN total_xp >= 451968 THEN 24
      WHEN total_xp >= 407008 THEN 23
      WHEN total_xp >= 365024 THEN 22
      WHEN total_xp >= 325920 THEN 21
      WHEN total_xp >= 289600 THEN 20
      WHEN total_xp >= 255968 THEN 19
      WHEN total_xp >= 224928 THEN 18
      WHEN total_xp >= 196384 THEN 17
      WHEN total_xp >= 170240 THEN 16
      WHEN total_xp >= 146400 THEN 15
      WHEN total_xp >= 124768 THEN 14
      WHEN total_xp >= 105248 THEN 13
      WHEN total_xp >= 87744 THEN 12
      WHEN total_xp >= 72160 THEN 11
      WHEN total_xp >= 58400 THEN 10
      WHEN total_xp >= 46368 THEN 9
      WHEN total_xp >= 35968 THEN 8
      WHEN total_xp >= 27104 THEN 7
      WHEN total_xp >= 19680 THEN 6
      WHEN total_xp >= 13600 THEN 5
      WHEN total_xp >= 8768 THEN 4
      WHEN total_xp >= 5088 THEN 3
      WHEN total_xp >= 2464 THEN 2
      WHEN total_xp >= 800 THEN 1
      ELSE 0
    END AS level
  FROM player_progression_profiles
)
UPDATE player_progression_profiles AS profile
SET level = projected.level,
    curve_version = 2,
    persistence_version = profile.persistence_version + 1
FROM projected
WHERE projected.player_id = profile.player_id
  AND (
    profile.level IS DISTINCT FROM projected.level
    OR profile.curve_version IS DISTINCT FROM 2
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM progression_curve_v2_xp_guard AS retained
    FULL JOIN player_progression_profiles AS current USING (player_id)
    WHERE retained.player_id IS NULL
       OR current.player_id IS NULL
       OR retained.total_xp IS DISTINCT FROM current.total_xp
  ) THEN
    RAISE EXCEPTION 'Curve V2 reconciliation changed retained player XP';
  END IF;
END
$$;

DROP TABLE progression_curve_v2_xp_guard;
