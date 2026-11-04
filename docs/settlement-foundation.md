# Settlement foundation

City Hall founding is server-authoritative. The selected founding flag's center is the sole City
Hall coordinate resolved through the World API; clients cannot supply coordinates, a settlement
ID, or a city name. The connected player must stand inside that flag's territory. The flag center
must be inside an authoritative settlement polygon, whose stable World settlement ID enforces one
active Ash Atlas city per real-world settlement. World authority permits founding only in eligible
settlement classes with a verified population of at least 20,000. Missing population data fails
closed, so a settlement cannot be founded until World authority supplies a verified population.

Founding locks every flag in the compact annex radius before it changes state. Any flag affiliated
with another active city aborts the whole transaction. On success, all radius flags receive the new
city affiliation while their personal `owner_id` remains unchanged. The founder receives a durable
`founder` membership, which is also the authority for the profile Home Settlement field.

Destroyed and abandoned cities are deactivated transactionally, release their flag affiliations,
close active membership rows, and record a seven-day `rebuild_available_at` cooldown. Founding uses
the same stable World settlement ID to enforce that cooldown.

City snapshots are selected by City Hall geography with a configured radius and hard result limit.
The client renders city-affiliated flag centers and territory black while retaining personal owner
identity in the snapshot and database.

Settlement schema begins at `0200_city_foundation.sql`. The migration can upgrade an isolated
feature database that previously applied `0016_city_foundation.sql`; fresh databases apply profile
schema `0100` before settlement schema `0200`.
