-- Stack-specific drops bind the selected stack into their replay hash. Keep the
-- commit-boundary validator aligned with the same hash recorded on the exact
-- authoritative inventory operation, while retaining the legacy fallback.
DO $migration$
DECLARE
  definition text;
  previous_check text :=
    'OR target_request.request_hash IS DISTINCT FROM expected_request_hash';
  current_check text :=
    'OR target_request.request_hash IS DISTINCT FROM coalesce(
          (SELECT operation.metadata ->> ''requestHash''
           FROM inventory_operations operation
           WHERE operation.operation_key = target_drop.operation_key),
          expected_request_hash
        )';
BEGIN
  SELECT pg_get_functiondef(
    'validate_world_item_drop_commit(uuid)'::regprocedure
  ) INTO definition;

  IF position(current_check IN definition) > 0 THEN
    RETURN;
  END IF;
  IF position(previous_check IN definition) = 0 THEN
    RAISE EXCEPTION
      'validate_world_item_drop_commit no longer has the expected replay hash check';
  END IF;

  EXECUTE replace(definition, previous_check, current_check);
END;
$migration$;
