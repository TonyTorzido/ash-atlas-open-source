-- Repair the burn-duration invariant for the persisted pause/resume lifecycle.
-- A contested repair captures the remaining duration and temporarily moves
-- completes_at to the database-clock pause deadline.  Resuming the burn does
-- the same from the captured remaining duration, so completes_at cannot stay
-- tied to the original started_at after either transition.

ALTER TABLE flag_burn_operations
  DROP CONSTRAINT IF EXISTS flag_burn_operations_duration_check;

ALTER TABLE flag_burn_operations
  ADD CONSTRAINT flag_burn_operations_duration_check CHECK (
    burn_duration_ms IN (25000, 79200000)
    AND completes_at > started_at
  );
