-- Recreating the progression telemetry view in 0748 dropped its exporter grant.

GRANT SELECT ON telemetry.authoritative_progression_events
TO ash_atlas_telemetry_exporter;
