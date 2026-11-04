ALTER TABLE city_structures
  ADD COLUMN IF NOT EXISTS construction_started_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS construction_completes_at timestamptz NULL;

ALTER TABLE city_structures
  DROP CONSTRAINT IF EXISTS city_structures_check,
  DROP CONSTRAINT IF EXISTS city_structures_state_timestamps_check,
  DROP CONSTRAINT IF EXISTS city_structures_construction_deadline_check;

ALTER TABLE city_structures
  ADD CONSTRAINT city_structures_state_timestamps_check CHECK (
    (
      state = 'constructing'
      AND built_at IS NULL
      AND destroyed_at IS NULL
      AND construction_started_at IS NOT NULL
      AND construction_completes_at IS NOT NULL
    )
    OR (
      state = 'active'
      AND built_at IS NOT NULL
      AND destroyed_at IS NULL
      AND (
        (construction_started_at IS NULL AND construction_completes_at IS NULL)
        OR
        (construction_started_at IS NOT NULL AND construction_completes_at IS NOT NULL)
      )
    )
    OR (
      state = 'destroyed'
      AND built_at IS NOT NULL
      AND destroyed_at IS NOT NULL
      AND (
        (construction_started_at IS NULL AND construction_completes_at IS NULL)
        OR
        (construction_started_at IS NOT NULL AND construction_completes_at IS NOT NULL)
      )
    )
  ),
  ADD CONSTRAINT city_structures_construction_deadline_check CHECK (
    construction_started_at IS NULL
    OR construction_completes_at > construction_started_at
  );

DROP INDEX IF EXISTS city_structures_one_active_house_per_player_idx;
DROP INDEX IF EXISTS city_structures_one_active_facility_type_idx;
DROP INDEX IF EXISTS city_structures_one_active_mayor_house_idx;

CREATE UNIQUE INDEX city_structures_one_reserved_house_per_player_idx
  ON city_structures (owner_player_id)
  WHERE state IN ('constructing', 'active')
    AND structure_type IN ('city_house', 'mayor_house');
CREATE UNIQUE INDEX city_structures_one_reserved_facility_type_idx
  ON city_structures (city_id, structure_type)
  WHERE state IN ('constructing', 'active')
    AND structure_type IN ('warehouse', 'weaponsmith', 'armory');
CREATE UNIQUE INDEX city_structures_one_reserved_mayor_house_idx
  ON city_structures (city_id)
  WHERE state IN ('constructing', 'active')
    AND structure_type = 'mayor_house';
CREATE INDEX city_structures_due_construction_idx
  ON city_structures (construction_completes_at, structure_id)
  WHERE state = 'constructing';

ALTER TABLE city_structure_events
  DROP CONSTRAINT IF EXISTS city_structure_events_event_type_check;
ALTER TABLE city_structure_events
  ADD CONSTRAINT city_structure_events_event_type_check CHECK (
    event_type IN (
      'built', 'activated', 'upgraded', 'destroyed',
      'promoted_to_mayor_house', 'demoted_to_city_house'
    )
  );

CREATE TABLE city_structure_material_spend (
  structure_id uuid NOT NULL REFERENCES city_structures(structure_id) ON DELETE RESTRICT,
  tier smallint NOT NULL CHECK (tier BETWEEN 1 AND 3),
  item_id text NOT NULL REFERENCES item_definitions(item_id) ON DELETE RESTRICT,
  variant text NOT NULL DEFAULT 'default',
  quantity bigint NOT NULL CHECK (quantity > 0),
  paid_by_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  source_operation_key text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (structure_id, tier, item_id, variant)
);
CREATE INDEX city_structure_material_spend_payer_idx
  ON city_structure_material_spend (paid_by_player_id, recorded_at, structure_id);

WITH tier_costs(structure_type, tier, item_id, quantity) AS (
  VALUES
    ('city_house', 1, 'wood', 25::bigint),
    ('city_house', 1, 'stone', 15::bigint),
    ('mayor_house', 1, 'wood', 25::bigint),
    ('mayor_house', 1, 'stone', 15::bigint),
    ('warehouse', 1, 'wood', 100::bigint),
    ('warehouse', 1, 'stone', 75::bigint),
    ('warehouse', 2, 'wood', 200::bigint),
    ('warehouse', 2, 'stone', 175::bigint),
    ('warehouse', 3, 'wood', 400::bigint),
    ('warehouse', 3, 'stone', 350::bigint),
    ('weaponsmith', 1, 'wood', 125::bigint),
    ('weaponsmith', 1, 'stone', 125::bigint),
    ('weaponsmith', 2, 'wood', 250::bigint),
    ('weaponsmith', 2, 'stone', 300::bigint),
    ('weaponsmith', 3, 'wood', 500::bigint),
    ('weaponsmith', 3, 'stone', 650::bigint),
    ('armory', 1, 'wood', 125::bigint),
    ('armory', 1, 'stone', 125::bigint),
    ('armory', 2, 'wood', 250::bigint),
    ('armory', 2, 'stone', 300::bigint),
    ('armory', 3, 'wood', 500::bigint),
    ('armory', 3, 'stone', 650::bigint)
), legacy AS (
  SELECT structure.structure_id, cost.tier, cost.item_id, cost.quantity,
         COALESCE(
           structure.owner_player_id,
           operation.actor_player_id,
           city.mayor_player_id,
           city.founder_player_id
         ) AS paid_by_player_id,
         COALESCE(operation.operation_key, structure.build_operation_key) AS source_operation_key
  FROM city_structures structure
  JOIN cities city ON city.id = structure.city_id
  JOIN tier_costs cost
    ON cost.structure_type = structure.structure_type
   AND cost.tier <= structure.tier
  LEFT JOIN LATERAL (
    SELECT candidate.operation_key, candidate.actor_player_id
    FROM city_structure_operations candidate
    WHERE candidate.structure_id = structure.structure_id
      AND (
        (cost.tier = 1 AND candidate.action IN ('build_house', 'build_facility'))
        OR
        (cost.tier > 1 AND candidate.action = 'upgrade_facility'
          AND (candidate.intent->>'targetTier')::integer = cost.tier)
      )
    ORDER BY candidate.created_at, candidate.operation_key
    LIMIT 1
  ) operation ON true
  WHERE structure.state IN ('active', 'destroyed')
)
INSERT INTO city_structure_material_spend (
  structure_id, tier, item_id, quantity, paid_by_player_id, source_operation_key
)
SELECT structure_id, tier, item_id, quantity, paid_by_player_id, source_operation_key
FROM legacy
ON CONFLICT DO NOTHING;

CREATE TABLE city_structure_refunds (
  operation_key text NOT NULL REFERENCES city_structure_operations(operation_key) ON DELETE RESTRICT,
  structure_id uuid NOT NULL REFERENCES city_structures(structure_id) ON DELETE RESTRICT,
  item_id text NOT NULL REFERENCES item_definitions(item_id) ON DELETE RESTRICT,
  variant text NOT NULL DEFAULT 'default',
  invested_quantity bigint NOT NULL CHECK (invested_quantity > 0),
  refund_quantity bigint NOT NULL CHECK (refund_quantity > 0),
  destination text NOT NULL CHECK (destination IN ('player_inventory', 'city_warehouse', 'ground_drop')),
  recipient_player_id text NULL REFERENCES players(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (operation_key, item_id, variant, destination)
);

CREATE TABLE flag_destruction_operations (
  operation_key text PRIMARY KEY,
  actor_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  flag_id uuid NOT NULL,
  intent jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  UNIQUE (actor_player_id, request_id),
  CHECK ((completed_at IS NULL) = (result IS NULL))
);

CREATE TABLE flag_material_spend (
  flag_id uuid NOT NULL,
  stage text NOT NULL CHECK (stage IN ('base', 'stone', 'atlas_shrine')),
  item_id text NOT NULL REFERENCES item_definitions(item_id) ON DELETE RESTRICT,
  variant text NOT NULL DEFAULT 'default',
  quantity bigint NOT NULL CHECK (quantity > 0),
  paid_by_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  source_operation_key text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (flag_id, stage, item_id, variant, paid_by_player_id)
);

INSERT INTO flag_material_spend (
  flag_id,stage,item_id,variant,quantity,paid_by_player_id,source_operation_key,created_at
)
SELECT event.source_entity_id::uuid,
       CASE event.source
         WHEN 'flag_construction' THEN 'base'
         WHEN 'flag_stone_upgrade' THEN 'stone'
         ELSE 'atlas_shrine'
       END,
       event.item_id,event.variant,sum(-event.delta_quantity),
       event.player_id,min(event.operation_key),min(event.created_at)
FROM inventory_events event
WHERE event.source_entity_type = 'flag'
  AND event.source IN (
    'flag_construction','flag_stone_upgrade','atlas_shrine_construction'
  )
  AND event.delta_quantity < 0
GROUP BY event.source_entity_id,event.source,event.item_id,event.variant,event.player_id
ON CONFLICT DO NOTHING;

WITH legacy_costs(stage,item_id,quantity,minimum_level) AS (
  VALUES
    ('base'::text,'wood'::text,3::bigint,0),
    ('base','leather',2::bigint,0),
    ('stone','stone',1::bigint,1),
    ('atlas_shrine','stone',10::bigint,2)
)
INSERT INTO flag_material_spend (
  flag_id,stage,item_id,variant,quantity,paid_by_player_id
)
SELECT flag.id,cost.stage,cost.item_id,'default',cost.quantity,
       COALESCE(
         flag.original_owner_player_id,
         flag.contributed_by_player_id,
         flag.owner_id
       )
FROM flags flag
JOIN legacy_costs cost ON COALESCE(flag.reinforcement_level,0) >= cost.minimum_level
WHERE NOT EXISTS (
  SELECT 1
  FROM flag_material_spend spend
  WHERE spend.flag_id = flag.id AND spend.stage = cost.stage
)
ON CONFLICT DO NOTHING;

CREATE TABLE flag_destruction_refunds (
  operation_key text NOT NULL REFERENCES flag_destruction_operations(operation_key) ON DELETE RESTRICT,
  paid_by_player_id text NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  item_id text NOT NULL REFERENCES item_definitions(item_id) ON DELETE RESTRICT,
  variant text NOT NULL DEFAULT 'default',
  invested_quantity bigint NOT NULL CHECK (invested_quantity > 0),
  refund_quantity bigint NOT NULL CHECK (refund_quantity > 0),
  inventory_quantity bigint NOT NULL CHECK (inventory_quantity >= 0),
  dropped_quantity bigint NOT NULL CHECK (dropped_quantity >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (operation_key, paid_by_player_id, item_id, variant),
  CHECK (inventory_quantity + dropped_quantity = refund_quantity)
);

CREATE OR REPLACE FUNCTION reject_city_structure_finance_history_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'city structure spend and refund history is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER city_structure_material_spend_immutable
BEFORE UPDATE OR DELETE ON city_structure_material_spend
FOR EACH ROW EXECUTE FUNCTION reject_city_structure_finance_history_mutation();
CREATE TRIGGER city_structure_refunds_immutable
BEFORE UPDATE OR DELETE ON city_structure_refunds
FOR EACH ROW EXECUTE FUNCTION reject_city_structure_finance_history_mutation();
CREATE TRIGGER flag_destruction_refunds_immutable
BEFORE UPDATE OR DELETE ON flag_destruction_refunds
FOR EACH ROW EXECUTE FUNCTION reject_city_structure_finance_history_mutation();
CREATE TRIGGER flag_material_spend_immutable
BEFORE UPDATE OR DELETE ON flag_material_spend
FOR EACH ROW EXECUTE FUNCTION reject_city_structure_finance_history_mutation();

CREATE TABLE world_item_system_drop_sources (
  drop_id uuid PRIMARY KEY REFERENCES world_item_drops(id) ON DELETE RESTRICT,
  operation_key text NOT NULL UNIQUE,
  source_entity_type text NOT NULL,
  source_entity_id text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE world_item_movements
  DROP CONSTRAINT world_item_movements_movement_kind_check,
  DROP CONSTRAINT world_item_movements_check;
ALTER TABLE world_item_movements
  ADD CONSTRAINT world_item_movements_movement_kind_check CHECK (
    movement_kind IN (
      'player_to_world', 'system_to_world', 'world_to_player', 'world_to_destruction'
    )
  ),
  ADD CONSTRAINT world_item_movements_check CHECK (
    (movement_kind = 'player_to_world'
      AND operation_key IS NOT NULL AND pickup_operation_key IS NULL AND player_id IS NOT NULL)
    OR (movement_kind = 'system_to_world'
      AND operation_key IS NULL AND pickup_operation_key IS NULL AND player_id IS NOT NULL)
    OR (movement_kind = 'world_to_player'
      AND operation_key IS NOT NULL AND pickup_operation_key = operation_key AND player_id IS NOT NULL)
    OR (movement_kind = 'world_to_destruction'
      AND operation_key IS NULL AND pickup_operation_key IS NULL AND player_id IS NULL)
  );
CREATE UNIQUE INDEX world_item_movements_system_creation_unique_idx
  ON world_item_movements (drop_id) WHERE movement_kind = 'system_to_world';

ALTER FUNCTION validate_world_item_drop_commit(uuid)
  RENAME TO validate_player_world_item_drop_commit;

CREATE OR REPLACE FUNCTION validate_world_item_drop_commit(target_drop_id uuid)
RETURNS void AS $$
DECLARE
  target_drop world_item_drops%ROWTYPE;
  source world_item_system_drop_sources%ROWTYPE;
  creation_count bigint;
  creation_quantity numeric;
  pickup_quantity numeric;
  destruction_count bigint;
  destruction_quantity numeric;
BEGIN
  SELECT * INTO source
  FROM world_item_system_drop_sources
  WHERE drop_id = target_drop_id;
  IF NOT FOUND THEN
    PERFORM validate_player_world_item_drop_commit(target_drop_id);
    RETURN;
  END IF;

  SELECT * INTO target_drop FROM world_item_drops WHERE id = target_drop_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'system world item source references a missing drop';
  END IF;
  SELECT count(*), coalesce(sum(quantity), 0)
  INTO creation_count, creation_quantity
  FROM world_item_movements
  WHERE drop_id = target_drop_id AND movement_kind = 'system_to_world';
  SELECT coalesce(sum(quantity), 0)
  INTO pickup_quantity
  FROM world_item_movements
  WHERE drop_id = target_drop_id AND movement_kind = 'world_to_player';
  SELECT count(*), coalesce(sum(quantity), 0)
  INTO destruction_count, destruction_quantity
  FROM world_item_movements
  WHERE drop_id = target_drop_id AND movement_kind = 'world_to_destruction';

  IF source.operation_key IS DISTINCT FROM target_drop.operation_key
     OR source.reason = ''
     OR creation_count <> 1
     OR creation_quantity <> target_drop.original_quantity
     OR EXISTS (
       SELECT 1 FROM world_item_drop_requests request
       WHERE request.drop_id = target_drop_id
     )
     OR EXISTS (
       SELECT 1 FROM world_item_movements movement
       WHERE movement.drop_id = target_drop_id
         AND movement.movement_kind = 'system_to_world'
         AND (
           movement.operation_key IS NOT NULL
           OR movement.player_id IS DISTINCT FROM target_drop.dropped_by
           OR movement.reason IS DISTINCT FROM source.reason
         )
     ) THEN
    RAISE EXCEPTION 'system world item creation evidence is inconsistent';
  END IF;
  IF EXISTS (
    SELECT 1 FROM world_item_movements movement
    WHERE movement.drop_id = target_drop_id
      AND (movement.item_id <> target_drop.item_id OR movement.variant <> target_drop.variant)
  ) THEN
    RAISE EXCEPTION 'system world item movement identity disagrees with its drop';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM world_item_movements movement
    LEFT JOIN inventory_operations inventory_operation
      ON inventory_operation.operation_key = movement.operation_key
    LEFT JOIN inventory_events event
      ON event.operation_key = movement.operation_key
     AND event.player_id = movement.player_id
     AND event.item_id = target_drop.item_id
     AND event.variant = target_drop.variant
    WHERE movement.drop_id = target_drop_id
      AND movement.movement_kind = 'world_to_player'
      AND (
        inventory_operation.operation_key IS NULL
        OR inventory_operation.player_id IS DISTINCT FROM movement.player_id
        OR inventory_operation.source IS DISTINCT FROM 'pickup_dropped_item'
        OR inventory_operation.source_entity_type IS DISTINCT FROM 'world_item_drop'
        OR inventory_operation.source_entity_id IS DISTINCT FROM target_drop.id::text
        OR event.id IS NULL
        OR event.source IS DISTINCT FROM 'pickup_dropped_item'
        OR event.source_entity_type IS DISTINCT FROM 'world_item_drop'
        OR event.source_entity_id IS DISTINCT FROM target_drop.id::text
        OR event.delta_quantity <> movement.quantity
        OR movement.reason IS DISTINCT FROM 'drop_picked_up'
      )
  ) THEN
    RAISE EXCEPTION 'system world item pickup lacks its exact inventory transition';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM world_item_pickups pickup
    LEFT JOIN world_item_movements movement
      ON movement.pickup_operation_key = pickup.operation_key
     AND movement.movement_kind = 'world_to_player'
    WHERE pickup.drop_id = target_drop_id
      AND (
        movement.movement_id IS NULL
        OR movement.drop_id IS DISTINCT FROM pickup.drop_id
        OR movement.player_id <> pickup.player_id
        OR movement.quantity <> pickup.granted_quantity
      )
  ) THEN
    RAISE EXCEPTION 'system world item pickup lacks one exact custody movement';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT pickup.remaining_quantity, pickup.resulting_status,
             target_drop.original_quantity - sum(pickup.granted_quantity) OVER (
               PARTITION BY pickup.drop_id ORDER BY pickup.pickup_sequence
             ) AS expected_remaining
      FROM world_item_pickups pickup
      WHERE pickup.drop_id = target_drop_id
    ) ordered
    WHERE ordered.remaining_quantity <> ordered.expected_remaining
       OR (ordered.remaining_quantity = 0) <> (ordered.resulting_status = 'picked_up')
  ) THEN
    RAISE EXCEPTION 'system world item pickup remainder chain is inconsistent';
  END IF;
  IF pickup_quantity + destruction_quantity + target_drop.remaining_quantity
     <> target_drop.original_quantity THEN
    RAISE EXCEPTION 'system world item custody does not conserve original quantity';
  END IF;
  IF target_drop.status = 'active' AND destruction_count <> 0 THEN
    RAISE EXCEPTION 'active system world item cannot have destruction movement';
  ELSIF target_drop.status = 'picked_up' THEN
    IF pickup_quantity <> target_drop.original_quantity OR destruction_count <> 0
       OR NOT EXISTS (
         SELECT 1 FROM world_item_pickups pickup
         WHERE pickup.drop_id = target_drop.id
           AND pickup.operation_key = target_drop.pickup_operation_key
           AND pickup.player_id = target_drop.picked_up_by
           AND pickup.remaining_quantity = 0
           AND pickup.resulting_status = 'picked_up'
           AND pickup.created_at = target_drop.picked_up_at
       ) THEN
      RAISE EXCEPTION 'picked-up system world item custody is incomplete';
    END IF;
  ELSIF target_drop.status IN ('expired', 'cancelled') THEN
    IF destruction_count <> 1 OR destruction_quantity <= 0
       OR NOT EXISTS (
         SELECT 1 FROM world_item_movements movement
         WHERE movement.drop_id = target_drop.id
           AND movement.movement_kind = 'world_to_destruction'
           AND movement.created_at = target_drop.expired_at
           AND movement.reason = CASE WHEN target_drop.status = 'cancelled'
             THEN 'legacy_cancelled_sink' ELSE 'expired_sink' END
       ) THEN
      RAISE EXCEPTION 'expired system world item must retain destruction evidence';
    END IF;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER world_item_system_drop_sources_immutable
BEFORE UPDATE OR DELETE ON world_item_system_drop_sources
FOR EACH ROW EXECUTE FUNCTION reject_market_immutable_mutation();
