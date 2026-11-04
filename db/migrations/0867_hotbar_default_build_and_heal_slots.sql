-- Quick slots: the flag/buoy builder and Giving Berry heal moved off the
-- floating HUD buttons into the hotbar. Seed them once into each saved
-- layout's bottom row (left = builder, right = heal) where that slot is empty.
-- Player choices are never overwritten; legacy six/eight-slot rows are
-- normalized to the current ten-slot order. Rows with the hotbar hidden
-- (row_count 0) are left alone. Players without a row get the same defaults
-- from the runtime.
WITH seeded AS (
  SELECT
    hotbar.player_id,
    (
      SELECT jsonb_agg(
        jsonb_build_object(
          'slotId', ids.slot_id,
          'binding', CASE
            WHEN existing.binding IS NOT NULL AND existing.binding <> 'null'::jsonb THEN existing.binding
            WHEN ids.slot_id = 'left-' || hotbar.row_count
              THEN '{"kind":"action","actionId":"anchor_build"}'::jsonb
            WHEN ids.slot_id = 'right-' || hotbar.row_count
              THEN '{"kind":"consumable","itemId":"giving_berry","variant":null}'::jsonb
            ELSE 'null'::jsonb
          END
        )
        ORDER BY ids.ordinal
      )
      FROM unnest(ARRAY[
        'left-1', 'left-2', 'left-3', 'left-4', 'left-5',
        'right-1', 'right-2', 'right-3', 'right-4', 'right-5'
      ]) WITH ORDINALITY AS ids(slot_id, ordinal)
      LEFT JOIN LATERAL (
        SELECT slot->'binding' AS binding
        FROM jsonb_array_elements(hotbar.slots) AS slot
        WHERE slot->>'slotId' = ids.slot_id
        LIMIT 1
      ) existing ON true
    ) AS slots
  FROM player_hotbar_settings hotbar
  WHERE hotbar.row_count BETWEEN 1 AND 5
    AND jsonb_typeof(hotbar.slots) = 'array'
)
UPDATE player_hotbar_settings hotbar
SET slots = seeded.slots,
    revision = hotbar.revision + 1
FROM seeded
WHERE seeded.player_id = hotbar.player_id
  AND seeded.slots IS DISTINCT FROM hotbar.slots;
