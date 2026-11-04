# Hunger Foundation

The player record now carries authoritative current Hunger and a shared base
capacity of 2,000. The persistence, session bootstrap, and player projection
paths are ready for later gameplay to consume and restore that value.

The current food slice adds Kitchen-produced Simple Food restoration. The V1
travel slice adds a debit only to deliberate long-distance overworld World Map
and flag jumps. It intentionally does not add passive drain, death/combat
drain, farming, buffs, or a new movement pipeline.

## V1 travel consumption

The canonical authority is `performAuthoritativeTravel` →
`applyAuthoritativeTravelPhase1`. World Map city, Kingdom/Atlas Shrine, and
flag jumps consume Hunger; party manual/auto-follow and Travel Invite arrivals
consume it when their destination is an overworld/flag layer. City House,
Market, and Warehouse structure travel, Manor/building and dungeon portals,
manual movement, GPS Relocate, respawn/recovery, reconnect recentering, and
forced/server/developer/pet relocation are exempt. A forced anti-stranding
recenter explicitly opts out even when it reuses the shared authority.

The cost is `ceil(100 * authoritativeDistanceM / maxRangeM)`, clamped to
`1..100`. `maxRangeM` is the existing
`WORLD_MAP_DISTANCE_AT_MAX_DURATION_M` (5,000,000 m), shared with World Map
travel duration; no second travel range is introduced. The shared cost helper
centralizes the min/max constants. Each party traveler pays the cost calculated
from their own authoritative starting position; existing leave-behind behavior
is preserved.

The Hunger row lock, relocation persistence, and
`travel_hunger_consumption_operations` request ledger share one transaction.
Insufficient Hunger returns `You need N Hunger to make that journey.` and
leaves position, Hunger, and other travel resources unchanged. Replays verify
the destination identity and return the already-committed state without a
second debit; concurrent requests serialize on the player row and cannot
overspend. Travel writes preserve a future over-cap value while subtracting
the debit. The authoritative travel player snapshot immediately refreshes the
Hunger HUD, and reconnect loads the same persisted Hunger authority.

The recurring economy is Hunter → Kitchen → Traveler for current combat food:
real kills have one uniform 5% chance to produce one non-edible Kitchen
ingredient, and each ingredient's recipe converts one input to its configured
Simple Food yield. Species meat is now a direct combat/harvest output and the retired Butcher → Cook chain is no longer part of live gameplay.
available for retained inventory and historical compatibility. Simple Food
restores up to 100 Hunger for future journeys. The travel debit is separate
from food production and consumption, so zero Hunger blocks only costing
jumps; walking, GPS Relocate, portals, recovery, and eating remain available.
