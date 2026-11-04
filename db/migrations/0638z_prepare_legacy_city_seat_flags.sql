-- City founding before the territory redesign did not require a source flag.
-- Preserve retained cities by selecting one eligible legacy personal flag whose
-- claim covers the recorded hall, or by creating a minimal legacy source flag
-- at an otherwise unclaimed hall coordinate. Migration 0639 converts it to the
-- explicit City Seat control state and preserves its owner/builder identity.
WITH candidates AS (
  SELECT city.id AS city_id, flag.id AS flag_id,
         row_number() OVER (
           PARTITION BY city.id
           ORDER BY ST_Distance(flag.geom::geography, city.hall_geom::geography),
                    flag.created_at, flag.id
         ) AS candidate_rank
  FROM cities city
  JOIN flags flag
    ON flag.control_type = 'personal'
   AND flag.city_id IS NULL
   AND flag.kingdom_id IS NULL
   AND ST_DWithin(
     flag.geom::geography,
     city.hall_geom::geography,
     flag.claim_radius_m
   )
  WHERE NOT EXISTS (SELECT 1 FROM flags existing WHERE existing.city_id = city.id)
)
UPDATE flags flag
SET city_id = candidates.city_id
FROM candidates
WHERE flag.id = candidates.flag_id
  AND candidates.candidate_rank = 1;

INSERT INTO flags (
  id, owner_id, name, lat, lon, claim_radius_m, geom, city_id
)
SELECT gen_random_uuid(), city.founder_player_id,
       left(city.name || ' Legacy City Seat', 64),
       city.hall_lat, city.hall_lon, 1,
       city.hall_geom, city.id
FROM cities city
WHERE NOT EXISTS (SELECT 1 FROM flags existing WHERE existing.city_id = city.id);
