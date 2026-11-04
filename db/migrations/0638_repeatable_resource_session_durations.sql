-- Persist the server-authoritative mining duration so mastery speed bonuses and
-- legitimate instant completions remain database-validated.

ALTER TABLE repeatable_resource_sessions
  ADD COLUMN effective_duration_ms bigint;

DROP TRIGGER IF EXISTS repeatable_resource_sessions_set_updated_at
  ON repeatable_resource_sessions;

UPDATE repeatable_resource_sessions
SET effective_duration_ms =
  ROUND(EXTRACT(EPOCH FROM (completes_at - started_at)) * 1000)::bigint;

CREATE TRIGGER repeatable_resource_sessions_set_updated_at
BEFORE UPDATE ON repeatable_resource_sessions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE repeatable_resource_sessions
  ALTER COLUMN effective_duration_ms SET NOT NULL,
  DROP CONSTRAINT repeatable_resource_sessions_check,
  ADD CONSTRAINT repeatable_resource_sessions_effective_duration_valid
    CHECK (effective_duration_ms BETWEEN 0 AND 10000),
  ADD CONSTRAINT repeatable_resource_sessions_completion_time_valid
    CHECK (
      completes_at =
        started_at + (effective_duration_ms * interval '1 millisecond')
    );
