-- Keep the database-authoritative mining-session bound aligned with the
-- current thirty-second starter mine duration. Existing sessions remain
-- valid because every previously accepted duration is within this bound.

ALTER TABLE repeatable_resource_sessions
  DROP CONSTRAINT repeatable_resource_sessions_effective_duration_valid,
  ADD CONSTRAINT repeatable_resource_sessions_effective_duration_valid
    CHECK (effective_duration_ms BETWEEN 0 AND 30000);
