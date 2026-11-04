-- The city-control backfill in 0639 updates retained flag rows before adding
-- indexes on flags. PostgreSQL cannot build those indexes while deferred
-- constraint-trigger events from the backfill are pending, so suspend the two
-- flag geometry/identity triggers and restore them after the lifecycle change.
DROP TRIGGER IF EXISTS flags_mixed_control_geometry ON flags;
DROP TRIGGER IF EXISTS flags_kingdom_seat_source_identity ON flags;
