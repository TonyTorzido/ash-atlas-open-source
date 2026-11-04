# Flag and player database domains

Migration `0614` preflights existing rows before installing constraints. It reports the
first invalid flag, player, or orphan owner and changes no retained row on failure.

Both tables enforce WGS84 latitude and longitude ranges. Player anchors are checked as
well. Stored point geometry must be nonempty and agree with the authoritative `lat` and
`lon` columns to within `1e-9` degrees. The geometry columns already carry PostGIS
`Point,4326` typmods, which enforce geometry type and SRID.

`flags.owner_id` now references `players.id` with `ON DELETE RESTRICT`. Player deletion
therefore fails while ownership-dependent flags exist; it never silently cascades a
player deletion into territory, environments, resource state, manors, travel, or city
state. Explicit flag lifecycle work must remove or transfer those dependencies before
the player row can be deleted.

The constraints are added `NOT VALID` to minimize the initial catalog lock, then
validated explicitly in the same per-file migration transaction after the readable
preflight.
