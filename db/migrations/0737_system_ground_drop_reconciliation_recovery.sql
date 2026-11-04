-- Recover the market only when its current pause was caused exclusively by the
-- reconciler misclassifying valid system-created ground drops as player drops.
DO $$
DECLARE
  first_failure_id bigint;
  first_failure_evidence jsonb;
  target_drop_id uuid;
BEGIN
  SELECT audit_event_id, evidence
  INTO first_failure_id, first_failure_evidence
  FROM market_audit_events
  WHERE event_type = 'market_reconciliation_failed'
    AND evidence->>'operatorIdentity' = 'system:market-reconciliation'
    AND evidence->'targetScope' = '{"type":"global","id":"global"}'::jsonb
    AND evidence->'issueCodes' = '["DROPPED_ITEM_CUSTODY_MISMATCH"]'::jsonb
    AND (evidence #>> '{priorState,global,read_only}')::boolean = false
    AND (evidence #>> '{priorState,global,new_orders_enabled}')::boolean = true
    AND (evidence #>> '{priorState,global,matching_enabled}')::boolean = true
  ORDER BY audit_event_id
  LIMIT 1;

  IF first_failure_id IS NULL THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM market_global_controls controls
    WHERE controls.singleton
      AND controls.read_only
      AND NOT controls.new_orders_enabled
      AND NOT controls.matching_enabled
      AND controls.cancellations_enabled =
        (first_failure_evidence #>> '{priorState,global,cancellations_enabled}')::boolean
      AND controls.claims_enabled =
        (first_failure_evidence #>> '{priorState,global,claims_enabled}')::boolean
      AND controls.auto_pause_on_invariant_failure =
        (first_failure_evidence #>> '{priorState,global,auto_pause_on_invariant_failure}')::boolean
      AND controls.rules_version =
        (first_failure_evidence #>> '{priorState,global,rules_version}')::integer
  ) THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM market_audit_events event
    WHERE event.audit_event_id > first_failure_id
      AND event.event_type = 'market_control_changed'
      AND event.evidence->>'operatorIdentity' IS DISTINCT FROM 'system:market-reconciliation'
  ) THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM market_audit_events event
    WHERE event.audit_event_id >= first_failure_id
      AND event.event_type = 'market_reconciliation_failed'
      AND (
        event.evidence->>'operatorIdentity' IS DISTINCT FROM 'system:market-reconciliation'
        OR event.evidence->'targetScope' IS DISTINCT FROM
          '{"type":"global","id":"global"}'::jsonb
        OR event.evidence->'issueCodes' IS DISTINCT FROM
          '["DROPPED_ITEM_CUSTODY_MISMATCH"]'::jsonb
        OR coalesce((event.evidence->>'evidenceTruncated')::boolean, true)
        OR coalesce((event.evidence->>'issueCount')::integer, -1) <>
          jsonb_array_length(coalesce(event.evidence->'issues', '[]'::jsonb))
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(coalesce(event.evidence->'issues', '[]'::jsonb)) issue
          WHERE issue->>'code' IS DISTINCT FROM 'DROPPED_ITEM_CUSTODY_MISMATCH'
             OR issue->>'scope' IS DISTINCT FROM 'world_item_drop'
             OR NOT EXISTS (
               SELECT 1
               FROM world_item_system_drop_sources source
               WHERE source.drop_id::text = issue->>'entityId'
             )
        )
      )
  ) THEN
    RETURN;
  END IF;

  FOR target_drop_id IN
    SELECT id FROM world_item_drops ORDER BY id
  LOOP
    PERFORM validate_world_item_drop_commit(target_drop_id);
  END LOOP;

  PERFORM set_config(
    'ash_atlas.market_control_operator',
    'system:migration:0737-system-ground-drop-reconciliation-recovery',
    true
  );
  PERFORM set_config(
    'ash_atlas.market_control_reason',
    'Restore controls after verified system ground-drop reconciliation false positive',
    true
  );
  PERFORM set_config(
    'ash_atlas.market_control_incident_id',
    'migration:0737-system-ground-drop-reconciliation-recovery',
    true
  );

  UPDATE market_global_controls
  SET read_only =
        (first_failure_evidence #>> '{priorState,global,read_only}')::boolean,
      new_orders_enabled =
        (first_failure_evidence #>> '{priorState,global,new_orders_enabled}')::boolean,
      matching_enabled =
        (first_failure_evidence #>> '{priorState,global,matching_enabled}')::boolean,
      updated_at = now()
  WHERE singleton;
END;
$$;
