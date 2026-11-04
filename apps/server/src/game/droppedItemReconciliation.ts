import type pg from "pg";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

export type DroppedItemReconciliationIssue = {
  code: string;
  scope: "world_item_drop" | "world_item_pickup" | "world_item_movement";
  entityId: string | null;
  details: Record<string, unknown>;
};

type IssueRow = {
  code: string;
  scope: DroppedItemReconciliationIssue["scope"];
  entity_id: string | null;
  details: Record<string, unknown>;
};

/**
 * Reconciles player inventory transitions against world custody and the
 * destruction sink. The query deliberately derives totals independently of
 * the deferred trigger functions so disabled-trigger corruption is visible.
 */
export async function reconcileDroppedItemCustody(
  queryable: Queryable
): Promise<DroppedItemReconciliationIssue[]> {
  const result = await queryable.query<IssueRow>(DROPPED_ITEM_RECONCILIATION_QUERY);
  return result.rows.map((row) => ({
    code: row.code,
    scope: row.scope,
    entityId: row.entity_id,
    details: row.details ?? {}
  }));
}

const DROPPED_ITEM_RECONCILIATION_QUERY = `/* economy-reconcile:world-item-custody */
  WITH movement_totals AS (
    SELECT drop_id,
           count(*) FILTER (WHERE movement_kind = 'player_to_world')::bigint
             AS player_creation_count,
           coalesce(sum(quantity) FILTER (WHERE movement_kind = 'player_to_world'), 0)::numeric
             AS player_created_quantity,
           count(*) FILTER (WHERE movement_kind = 'system_to_world')::bigint
             AS system_creation_count,
           coalesce(sum(quantity) FILTER (WHERE movement_kind = 'system_to_world'), 0)::numeric
             AS system_created_quantity,
           count(*) FILTER (WHERE movement_kind = 'world_to_player')::bigint AS pickup_count,
           coalesce(sum(quantity) FILTER (WHERE movement_kind = 'world_to_player'), 0)::numeric
             AS picked_quantity,
           count(*) FILTER (WHERE movement_kind = 'world_to_destruction')::bigint
             AS destruction_count,
           coalesce(sum(quantity) FILTER (WHERE movement_kind = 'world_to_destruction'), 0)::numeric
             AS destroyed_quantity
    FROM world_item_movements
    GROUP BY drop_id
  ), pickup_totals AS (
    SELECT drop_id, count(*)::bigint AS pickup_count,
           coalesce(sum(granted_quantity), 0)::numeric AS picked_quantity
    FROM world_item_pickups
    GROUP BY drop_id
  ), request_totals AS (
    SELECT drop_id, count(*)::bigint AS request_count
    FROM world_item_drop_requests
    GROUP BY drop_id
  ), system_source_totals AS (
    SELECT drop_id, count(*)::bigint AS source_count
    FROM world_item_system_drop_sources
    GROUP BY drop_id
  ), drop_issues AS (
    SELECT 'DROPPED_ITEM_CUSTODY_MISMATCH'::text AS code,
           'world_item_drop'::text AS scope,
           d.id::text AS entity_id,
           jsonb_build_object(
             'status', d.status,
             'originalQuantity', d.original_quantity::text,
             'remainingQuantity', d.remaining_quantity::text,
             'creationKind', CASE WHEN coalesce(source.source_count, 0) = 0
               THEN 'player' ELSE 'system' END,
             'playerCreationCount', coalesce(m.player_creation_count, 0)::text,
             'playerCreatedQuantity', coalesce(m.player_created_quantity, 0)::text,
             'systemCreationCount', coalesce(m.system_creation_count, 0)::text,
             'systemCreatedQuantity', coalesce(m.system_created_quantity, 0)::text,
             'systemSourceCount', coalesce(source.source_count, 0)::text,
             'pickupMovementCount', coalesce(m.pickup_count, 0)::text,
             'pickupRecordCount', coalesce(p.pickup_count, 0)::text,
             'pickedMovementQuantity', coalesce(m.picked_quantity, 0)::text,
             'pickedRecordQuantity', coalesce(p.picked_quantity, 0)::text,
             'destructionCount', coalesce(m.destruction_count, 0)::text,
             'destroyedQuantity', coalesce(m.destroyed_quantity, 0)::text,
             'requestCount', coalesce(r.request_count, 0)::text
           ) AS details
    FROM world_item_drops d
    LEFT JOIN movement_totals m ON m.drop_id = d.id
    LEFT JOIN pickup_totals p ON p.drop_id = d.id
    LEFT JOIN request_totals r ON r.drop_id = d.id
    LEFT JOIN system_source_totals source ON source.drop_id = d.id
    WHERE (coalesce(source.source_count, 0) = 0 AND (
            coalesce(m.player_creation_count, 0) <> 1
            OR coalesce(m.player_created_quantity, 0) <> d.original_quantity
            OR coalesce(m.system_creation_count, 0) <> 0
            OR coalesce(r.request_count, 0) <> 1
          ))
       OR (coalesce(source.source_count, 0) > 0 AND (
            coalesce(m.system_creation_count, 0) <> source.source_count
            OR coalesce(m.system_created_quantity, 0) <> d.original_quantity
            OR coalesce(m.player_creation_count, 0) <> 0
            OR coalesce(r.request_count, 0) <> 0
            OR NOT EXISTS (
              SELECT 1 FROM world_item_system_drop_sources original_source
              WHERE original_source.drop_id = d.id
                AND original_source.operation_key = d.operation_key
            )
            OR EXISTS (
              SELECT 1
              FROM world_item_system_drop_sources contribution
              LEFT JOIN world_item_movements creation
                ON creation.drop_id = contribution.drop_id
               AND creation.movement_kind = 'system_to_world'
               AND creation.operation_key = contribution.operation_key
              LEFT JOIN inventory_operations operation
                ON operation.operation_key = contribution.operation_key
              WHERE contribution.drop_id = d.id
                AND (
                  btrim(contribution.reason) = ''
                  OR creation.movement_id IS NULL
                  OR creation.player_id IS DISTINCT FROM operation.player_id
                  OR creation.reason IS DISTINCT FROM contribution.reason
                  OR operation.source IS DISTINCT FROM 'world_system_drop'
                  OR operation.source_entity_type IS DISTINCT FROM 'world_item_drop'
                  OR operation.source_entity_id IS DISTINCT FROM d.id::text
                )
            )
            OR EXISTS (
              SELECT 1
              FROM world_item_movements creation
              LEFT JOIN world_item_system_drop_sources contribution
                ON contribution.drop_id = creation.drop_id
               AND contribution.operation_key = creation.operation_key
              WHERE creation.drop_id = d.id
                AND creation.movement_kind = 'system_to_world'
                AND contribution.operation_key IS NULL
            )
          ))
       OR EXISTS (
            SELECT 1
            FROM world_item_movements movement
            WHERE movement.drop_id = d.id
              AND (
                movement.item_id IS DISTINCT FROM d.item_id
                OR movement.variant IS DISTINCT FROM d.variant
              )
          )
       OR coalesce(m.pickup_count, 0) <> coalesce(p.pickup_count, 0)
       OR coalesce(m.picked_quantity, 0) <> coalesce(p.picked_quantity, 0)
       OR d.original_quantity <> d.remaining_quantity
            + coalesce(m.picked_quantity, 0) + coalesce(m.destroyed_quantity, 0)
       OR (d.status = 'active' AND coalesce(m.destruction_count, 0) <> 0)
       OR (d.status = 'picked_up' AND (
            d.remaining_quantity <> 0
            OR coalesce(m.picked_quantity, 0) <> d.original_quantity
            OR coalesce(m.destruction_count, 0) <> 0
          ))
       OR (d.status IN ('expired', 'cancelled') AND (
            d.remaining_quantity <> 0 OR coalesce(m.destruction_count, 0) <> 1
          ))
  ), movement_issues AS (
    SELECT 'DROPPED_ITEM_INVENTORY_MOVEMENT_MISMATCH'::text AS code,
           'world_item_movement'::text AS scope,
           movement.movement_id::text AS entity_id,
           jsonb_build_object(
             'dropId', movement.drop_id,
             'movementKind', movement.movement_kind,
             'operationKey', movement.operation_key,
             'quantity', movement.quantity::text,
             'matchingInventoryEvents', count(event.id)::text
           ) AS details
    FROM world_item_movements movement
    LEFT JOIN inventory_operations inventory_operation
      ON inventory_operation.operation_key = movement.operation_key
    LEFT JOIN inventory_events event
      ON event.operation_key = movement.operation_key
     AND event.player_id = movement.player_id
     AND event.item_id = movement.item_id
     AND event.variant = movement.variant
     AND event.delta_quantity = CASE
       WHEN movement.movement_kind = 'player_to_world' THEN -movement.quantity
       WHEN movement.movement_kind = 'world_to_player' THEN movement.quantity
       ELSE event.delta_quantity
     END
    WHERE movement.movement_kind IN ('player_to_world', 'world_to_player')
    GROUP BY movement.movement_id
    HAVING count(inventory_operation.operation_key) <> 1
       OR count(event.id) <> 1
       OR bool_or(inventory_operation.player_id IS DISTINCT FROM movement.player_id)
       OR bool_or(inventory_operation.source IS DISTINCT FROM CASE
            WHEN movement.movement_kind = 'player_to_world' THEN 'drop_item'
            ELSE 'pickup_dropped_item'
          END)
       OR bool_or(inventory_operation.source_entity_type IS DISTINCT FROM 'world_item_drop')
       OR bool_or(inventory_operation.source_entity_id IS DISTINCT FROM movement.drop_id::text)
       OR bool_or(event.source IS DISTINCT FROM CASE
            WHEN movement.movement_kind = 'player_to_world' THEN 'drop_item'
            ELSE 'pickup_dropped_item'
          END)
       OR bool_or(event.source_entity_type IS DISTINCT FROM 'world_item_drop')
       OR bool_or(event.source_entity_id IS DISTINCT FROM movement.drop_id::text)
       OR bool_or(movement.reason IS DISTINCT FROM CASE
            WHEN movement.movement_kind = 'player_to_world' THEN 'drop_created'
            ELSE 'drop_picked_up'
          END)
  ), operation_event_issues AS (
    SELECT 'DROPPED_ITEM_OPERATION_EXTRA_EVENT'::text AS code,
           'world_item_movement'::text AS scope,
           movement.movement_id::text AS entity_id,
           jsonb_build_object(
             'dropId', movement.drop_id,
             'movementKind', movement.movement_kind,
             'operationKey', movement.operation_key,
             'eventId', event.id,
             'eventItemId', event.item_id,
             'eventVariant', event.variant,
             'eventDelta', event.delta_quantity::text
           ) AS details
    FROM world_item_movements movement
    JOIN inventory_events event ON event.operation_key = movement.operation_key
    WHERE movement.movement_kind IN ('player_to_world', 'world_to_player')
      AND (
        event.player_id IS DISTINCT FROM movement.player_id
        OR event.item_id IS DISTINCT FROM movement.item_id
        OR event.variant IS DISTINCT FROM movement.variant
        OR event.delta_quantity IS DISTINCT FROM CASE
          WHEN movement.movement_kind = 'player_to_world' THEN -movement.quantity
          ELSE movement.quantity
        END
        OR event.source IS DISTINCT FROM CASE
          WHEN movement.movement_kind = 'player_to_world' THEN 'drop_item'
          ELSE 'pickup_dropped_item'
        END
        OR event.source_entity_type IS DISTINCT FROM 'world_item_drop'
        OR event.source_entity_id IS DISTINCT FROM movement.drop_id::text
      )
  ), pickup_movement_issues AS (
    SELECT 'DROPPED_ITEM_PICKUP_MOVEMENT_MISMATCH'::text AS code,
           'world_item_pickup'::text AS scope,
           pickup.operation_key::text AS entity_id,
           jsonb_build_object(
             'dropId', pickup.drop_id,
             'movementDropId', movement.drop_id,
             'playerId', pickup.player_id,
             'movementPlayerId', movement.player_id,
             'grantedQuantity', pickup.granted_quantity::text,
             'movementQuantity', movement.quantity::text
           ) AS details
    FROM world_item_pickups pickup
    LEFT JOIN world_item_movements movement
      ON movement.pickup_operation_key = pickup.operation_key
     AND movement.movement_kind = 'world_to_player'
    WHERE movement.movement_id IS NULL
       OR movement.drop_id IS DISTINCT FROM pickup.drop_id
       OR movement.player_id IS DISTINCT FROM pickup.player_id
       OR movement.quantity IS DISTINCT FROM pickup.granted_quantity
  ), pickup_chain_issues AS (
    SELECT 'DROPPED_ITEM_PICKUP_CHAIN_MISMATCH'::text AS code,
           'world_item_pickup'::text AS scope,
           operation_key::text AS entity_id,
           jsonb_build_object(
             'dropId', drop_id,
             'grantedQuantity', granted_quantity::text,
             'remainingQuantity', remaining_quantity::text,
             'expectedRemaining', expected_remaining::text,
             'resultingStatus', resulting_status
           ) AS details
    FROM (
      SELECT pickup.operation_key, pickup.drop_id, pickup.granted_quantity,
             pickup.remaining_quantity, pickup.resulting_status,
             d.original_quantity - sum(pickup.granted_quantity) OVER (
               PARTITION BY pickup.drop_id ORDER BY pickup.pickup_sequence
             ) AS expected_remaining
      FROM world_item_pickups pickup
      JOIN world_item_drops d ON d.id = pickup.drop_id
    ) ordered
    WHERE remaining_quantity <> expected_remaining
       OR (remaining_quantity = 0) <> (resulting_status = 'picked_up')
  )
  SELECT code, scope, entity_id, details FROM drop_issues
  UNION ALL
  SELECT code, scope, entity_id, details FROM movement_issues
  UNION ALL
  SELECT code, scope, entity_id, details FROM operation_event_issues
  UNION ALL
  SELECT code, scope, entity_id, details FROM pickup_movement_issues
  UNION ALL
  SELECT code, scope, entity_id, details FROM pickup_chain_issues
  ORDER BY scope, entity_id
`;
