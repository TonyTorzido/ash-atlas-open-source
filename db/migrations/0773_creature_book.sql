CREATE TABLE creature_book_sightings (
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  mob_archetype TEXT NOT NULL,
  first_source_entity_id TEXT NOT NULL,
  sighted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, mob_archetype),
  CHECK (mob_archetype IN ('deer','hog','coastal_crab','frog','wolf','bear','squid','sap_crawler','alligator','jellyfish','ogre','mysterious_traveler','fire_bird','lightning_bird','ice_bird','xoral'))
);

CREATE TABLE creature_book_kill_occurrences (
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  mob_archetype TEXT NOT NULL,
  credited_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, source_kind, source_id),
  CHECK (source_kind IN ('combat_settlement','legendary_bird_event','xoral_event')),
  CHECK (mob_archetype IN ('deer','hog','coastal_crab','frog','wolf','bear','squid','sap_crawler','alligator','jellyfish','ogre','mysterious_traveler','fire_bird','lightning_bird','ice_bird','xoral'))
);

CREATE INDEX creature_book_kills_player_archetype_idx
  ON creature_book_kill_occurrences (player_id, mob_archetype);

CREATE TABLE creature_book_drop_occurrences (
  player_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  awarded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, source_kind, source_id, item_id),
  FOREIGN KEY (player_id, source_kind, source_id)
    REFERENCES creature_book_kill_occurrences (player_id, source_kind, source_id)
    ON DELETE CASCADE
);

INSERT INTO creature_book_kill_occurrences (
  player_id,source_kind,source_id,mob_archetype,credited_at
)
SELECT reward_player_id,'combat_settlement',settlement_key,mob_archetype,
       COALESCE(completed_at,updated_at,created_at)
FROM combat_reward_settlements
WHERE status='completed' AND reward_player_id IS NOT NULL
  AND mob_archetype IN ('deer','hog','coastal_crab','frog','wolf','bear','squid','sap_crawler','alligator','jellyfish','ogre','mysterious_traveler')
ON CONFLICT DO NOTHING;

INSERT INTO creature_book_drop_occurrences (player_id,source_kind,source_id,item_id,awarded_at)
SELECT DISTINCT settlement.reward_player_id,'combat_settlement',settlement.settlement_key,
       reward.item_id,COALESCE(settlement.completed_at,settlement.updated_at,settlement.created_at)
FROM combat_reward_settlements settlement
CROSS JOIN LATERAL (
  SELECT value->>'itemId' AS item_id
  FROM jsonb_array_elements(COALESCE(settlement.result#>'{mobReward,items}','[]'::jsonb))
  UNION
  SELECT value->>'itemId' AS item_id
  FROM jsonb_array_elements(COALESCE(settlement.result#>'{mobReward,drops}','[]'::jsonb))
) reward
WHERE settlement.status='completed' AND settlement.reward_player_id IS NOT NULL
  AND reward.item_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM creature_book_kill_occurrences occurrence
    WHERE occurrence.player_id=settlement.reward_player_id
      AND occurrence.source_kind='combat_settlement'
      AND occurrence.source_id=settlement.settlement_key
  )
ON CONFLICT DO NOTHING;

INSERT INTO creature_book_kill_occurrences (
  player_id,source_kind,source_id,mob_archetype,credited_at
)
SELECT player_id,'xoral_event',event_id::text,'xoral',created_at
FROM xoral_event_rewards
ON CONFLICT DO NOTHING;

INSERT INTO creature_book_drop_occurrences (player_id,source_kind,source_id,item_id,awarded_at)
SELECT player_id,'xoral_event',event_id::text,ring_definition_id,created_at
FROM xoral_event_rewards
ON CONFLICT DO NOTHING;

INSERT INTO creature_book_sightings (
  player_id,mob_archetype,first_source_entity_id,sighted_at
)
SELECT player_id,mob_archetype,'credited-kill:' || source_kind || ':' || source_id,credited_at
FROM creature_book_kill_occurrences
ON CONFLICT DO NOTHING;
