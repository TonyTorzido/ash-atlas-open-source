-- Kingdom founding formerly converted every directly overlapping founder-owned
-- personal flag into a Kingdom Flag. Founding now changes only the selected
-- source flag. Restore legacy absorption rows only when the absorption is still
-- the flag's latest history and the Kingdom has no later, manually affiliated
-- Kingdom Flags whose network could depend on it.
CREATE TEMP TABLE kingdom_founding_absorption_repairs ON COMMIT DROP AS
WITH latest_history AS (
  SELECT DISTINCT ON (history.flag_id)
         history.flag_id,
         history.kingdom_id,
         history.action,
         history.reason
  FROM kingdom_flag_affiliation_history history
  ORDER BY history.flag_id, history.created_at DESC, history.id DESC
), unsafe_kingdoms AS (
  SELECT DISTINCT flag.kingdom_id
  FROM flags flag
  LEFT JOIN latest_history history ON history.flag_id = flag.id
  WHERE flag.control_type = 'kingdom'
    AND flag.kingdom_id IS NOT NULL
    AND NOT COALESCE(
      history.kingdom_id = flag.kingdom_id
      AND history.action = 'affiliated'
      AND history.reason = 'founding_overlap_absorption',
      false
    )
)
SELECT flag.id AS flag_id,
       flag.kingdom_id,
       flag.owner_id
FROM flags flag
JOIN latest_history history
  ON history.flag_id = flag.id
 AND history.kingdom_id = flag.kingdom_id
WHERE flag.control_type = 'kingdom'
  AND flag.kingdom_id IS NOT NULL
  AND flag.city_id IS NULL
  AND history.action = 'affiliated'
  AND history.reason = 'founding_overlap_absorption'
  AND NOT EXISTS (
    SELECT 1
    FROM unsafe_kingdoms unsafe
    WHERE unsafe.kingdom_id = flag.kingdom_id
  );

UPDATE flags flag
SET control_type = 'personal',
    kingdom_id = NULL,
    kingdom_affiliated_at = NULL,
    kingdom_affiliated_by_player_id = NULL,
    contributed_by_player_id = NULL
FROM kingdom_founding_absorption_repairs repair
WHERE flag.id = repair.flag_id;

INSERT INTO kingdom_flag_affiliation_history (
  id,
  kingdom_id,
  flag_id,
  flag_owner_player_id,
  performed_by_player_id,
  action,
  reason,
  request_id,
  prior_kingdom_id,
  resulting_kingdom_id,
  metadata
)
SELECT gen_random_uuid(),
       repair.kingdom_id,
       repair.flag_id,
       repair.owner_id,
       NULL,
       'released',
       'repair_founding_overlap_absorption',
       NULL,
       repair.kingdom_id,
       NULL,
       jsonb_build_object('automaticRepair', true)
FROM kingdom_founding_absorption_repairs repair;

UPDATE kingdoms kingdom
SET spatial_revision = nextval('kingdom_spatial_revision_seq')
WHERE kingdom.id IN (
  SELECT DISTINCT repair.kingdom_id
  FROM kingdom_founding_absorption_repairs repair
);
