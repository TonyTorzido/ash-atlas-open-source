-- Remove detailed resources retained by flags that became inactive under the
-- previous baked-entity lifecycle.

UPDATE flag_resource_spawn_events e
SET expired_at = clock_timestamp()
FROM flag_resource_spawn_allowances a
WHERE e.flag_id = a.flag_id AND NOT a.active AND e.expired_at IS NULL;

UPDATE harvest_sessions h
SET status = 'cancelled', cancelled_at = clock_timestamp()
WHERE h.status = 'active' AND h.node_id IN (
  SELECT n.id
  FROM collectible_nodes n
  JOIN flag_resource_spawn_allowances a ON a.flag_id = n.source_flag_id
  WHERE NOT a.active
);

DELETE FROM collectible_nodes n
USING flag_resource_spawn_allowances a
WHERE n.source_flag_id = a.flag_id AND NOT a.active;

DELETE FROM generated_resource_wolves w
USING flag_resource_spawn_allowances a
WHERE w.source_flag_id = a.flag_id AND NOT a.active;
