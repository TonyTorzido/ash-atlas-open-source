-- A visible system ground stack may receive several immutable combat/source
-- contributions. Each contribution keeps its own operation and custody movement.
DROP TRIGGER IF EXISTS world_item_system_drop_sources_immutable
  ON world_item_system_drop_sources;
ALTER TABLE world_item_system_drop_sources
  DROP CONSTRAINT world_item_system_drop_sources_pkey,
  ADD PRIMARY KEY (drop_id, operation_key);
CREATE INDEX world_item_system_drop_sources_drop_idx
  ON world_item_system_drop_sources (drop_id, created_at, operation_key);
CREATE TRIGGER world_item_system_drop_sources_immutable
BEFORE UPDATE OR DELETE ON world_item_system_drop_sources
FOR EACH ROW EXECUTE FUNCTION reject_market_immutable_mutation();

DROP TRIGGER IF EXISTS world_item_movements_immutable ON world_item_movements;
ALTER TABLE world_item_movements
  DROP CONSTRAINT world_item_movements_check;
UPDATE world_item_movements movement
SET operation_key = source.operation_key
FROM world_item_system_drop_sources source
WHERE movement.drop_id = source.drop_id
  AND movement.movement_kind = 'system_to_world'
  AND movement.operation_key IS NULL;

ALTER TABLE world_item_movements
  ADD CONSTRAINT world_item_movements_check CHECK (
    (movement_kind = 'player_to_world'
      AND operation_key IS NOT NULL AND pickup_operation_key IS NULL AND player_id IS NOT NULL)
    OR (movement_kind = 'system_to_world'
      AND operation_key IS NOT NULL AND pickup_operation_key IS NULL AND player_id IS NOT NULL)
    OR (movement_kind = 'world_to_player'
      AND operation_key IS NOT NULL AND pickup_operation_key = operation_key AND player_id IS NOT NULL)
    OR (movement_kind = 'world_to_destruction'
      AND operation_key IS NULL AND pickup_operation_key IS NULL AND player_id IS NULL)
  );
DROP INDEX world_item_movements_system_creation_unique_idx;
CREATE UNIQUE INDEX world_item_movements_system_operation_unique_idx
  ON world_item_movements (operation_key) WHERE movement_kind = 'system_to_world';
CREATE TRIGGER world_item_movements_immutable
BEFORE UPDATE OR DELETE ON world_item_movements
FOR EACH ROW EXECUTE FUNCTION reject_market_immutable_mutation();

CREATE OR REPLACE FUNCTION enforce_world_item_drop_transition()
RETURNS trigger AS $$
DECLARE
  authorized_merge_id text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'world item drops cannot be deleted';
  END IF;
  authorized_merge_id := current_setting('ash_atlas.system_ground_drop_merge', true);
  IF authorized_merge_id = OLD.id::text
     AND OLD.status = 'active' AND NEW.status = 'active'
     AND NEW.id = OLD.id AND NEW.operation_key = OLD.operation_key
     AND NEW.dropped_by = OLD.dropped_by AND NEW.region_code = OLD.region_code
     AND NEW.zone_id = OLD.zone_id AND NEW.pile_id = OLD.pile_id
     AND NEW.pile_order = OLD.pile_order
     AND NEW.item_id = OLD.item_id AND NEW.variant = OLD.variant
     AND NEW.lat = OLD.lat AND NEW.lon = OLD.lon AND ST_Equals(NEW.geom, OLD.geom)
     AND NEW.created_at = OLD.created_at AND NEW.expires_at >= OLD.expires_at
     AND NEW.original_quantity > OLD.original_quantity
     AND NEW.remaining_quantity - OLD.remaining_quantity =
       NEW.original_quantity - OLD.original_quantity
     AND NEW.pickup_operation_key IS NOT DISTINCT FROM OLD.pickup_operation_key
     AND NEW.picked_up_by IS NOT DISTINCT FROM OLD.picked_up_by
     AND NEW.picked_up_at IS NOT DISTINCT FROM OLD.picked_up_at
     AND NEW.expired_at IS NOT DISTINCT FROM OLD.expired_at
     AND NOT EXISTS (
       SELECT 1 FROM world_item_pickups pickup WHERE pickup.drop_id = OLD.id
     ) THEN
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.operation_key <> OLD.operation_key
     OR NEW.dropped_by <> OLD.dropped_by OR NEW.region_code <> OLD.region_code
     OR NEW.item_id <> OLD.item_id OR NEW.variant <> OLD.variant
     OR NEW.original_quantity <> OLD.original_quantity
     OR NEW.lat <> OLD.lat OR NEW.lon <> OLD.lon OR NOT ST_Equals(NEW.geom, OLD.geom)
     OR NEW.created_at <> OLD.created_at OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'world item drop identity and original quantity are immutable';
  END IF;
  IF NEW.remaining_quantity > OLD.remaining_quantity THEN
    RAISE EXCEPTION 'world item drop remaining quantity cannot increase';
  END IF;
  IF OLD.status <> 'active' AND (
       NEW.status IS DISTINCT FROM OLD.status
       OR NEW.remaining_quantity IS DISTINCT FROM OLD.remaining_quantity
       OR NEW.pickup_operation_key IS DISTINCT FROM OLD.pickup_operation_key
       OR NEW.picked_up_by IS DISTINCT FROM OLD.picked_up_by
       OR NEW.picked_up_at IS DISTINCT FROM OLD.picked_up_at
       OR NEW.expired_at IS DISTINCT FROM OLD.expired_at
     ) THEN
    RAISE EXCEPTION 'terminal world item drop state is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_world_item_drop_commit(target_drop_id uuid)
RETURNS void AS $$
DECLARE
  target_drop world_item_drops%ROWTYPE;
  source_count bigint;
  creation_count bigint;
  creation_quantity numeric;
  pickup_quantity numeric;
  destruction_count bigint;
  destruction_quantity numeric;
BEGIN
  SELECT count(*) INTO source_count
  FROM world_item_system_drop_sources
  WHERE drop_id = target_drop_id;
  IF source_count = 0 THEN
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

  IF creation_count <> source_count
     OR creation_quantity <> target_drop.original_quantity
     OR NOT EXISTS (
       SELECT 1 FROM world_item_system_drop_sources source
       WHERE source.drop_id = target_drop_id
         AND source.operation_key = target_drop.operation_key
     )
     OR EXISTS (
       SELECT 1 FROM world_item_drop_requests request
       WHERE request.drop_id = target_drop_id
     )
     OR EXISTS (
       SELECT 1
       FROM world_item_system_drop_sources source
       LEFT JOIN world_item_movements movement
         ON movement.drop_id = source.drop_id
        AND movement.movement_kind = 'system_to_world'
        AND movement.operation_key = source.operation_key
       LEFT JOIN inventory_operations operation
         ON operation.operation_key = source.operation_key
       WHERE source.drop_id = target_drop_id
         AND (
           btrim(source.reason) = ''
           OR movement.movement_id IS NULL
           OR movement.player_id IS DISTINCT FROM operation.player_id
           OR movement.reason IS DISTINCT FROM source.reason
           OR operation.source IS DISTINCT FROM 'world_system_drop'
           OR operation.source_entity_type IS DISTINCT FROM 'world_item_drop'
           OR operation.source_entity_id IS DISTINCT FROM target_drop_id::text
         )
     )
     OR EXISTS (
       SELECT 1
       FROM world_item_movements movement
       LEFT JOIN world_item_system_drop_sources source
         ON source.drop_id = movement.drop_id
        AND source.operation_key = movement.operation_key
       WHERE movement.drop_id = target_drop_id
         AND movement.movement_kind = 'system_to_world'
         AND source.operation_key IS NULL
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
    LEFT JOIN inventory_operations operation
      ON operation.operation_key = movement.operation_key
    LEFT JOIN inventory_events event
      ON event.operation_key = movement.operation_key
     AND event.player_id = movement.player_id
     AND event.item_id = target_drop.item_id
     AND event.variant = target_drop.variant
    WHERE movement.drop_id = target_drop_id
      AND movement.movement_kind = 'world_to_player'
      AND (
        operation.operation_key IS NULL
        OR operation.player_id IS DISTINCT FROM movement.player_id
        OR operation.source IS DISTINCT FROM 'pickup_dropped_item'
        OR operation.source_entity_type IS DISTINCT FROM 'world_item_drop'
        OR operation.source_entity_id IS DISTINCT FROM target_drop.id::text
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
