# Database-backed flag placement

Flag placement retains the established center rule: a new flag center is illegal when
it falls inside an existing flag's claim radius (including the existing 5 cm edge
tolerance). The new flag's radius is intentionally not added to that test, so claim
edges may overlap when both centers were legally placed. Own and enemy claims behave
the same way.

Migration `0612_database_flag_placement_invariant.sql` installs a `BEFORE INSERT` and
location-update trigger. The trigger takes a transaction-scoped, database-wide
advisory lock before its exact geography recheck. The lock remains held through the
writer's transaction, so a second process cannot validate against a stale snapshot and
insert an illegal center. Direct SQL writers receive SQLSTATE `23514` with constraint
identity `flags_center_outside_existing_claim`; the game service maps that identity to
a public placement conflict.

The migration first checks retained rows in creation order and fails with the
conflicting flag IDs rather than silently rewriting any placement. Rollback consists of
dropping the trigger and function; existing flags are not modified.
