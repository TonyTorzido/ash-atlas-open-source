# Basic Combat Foundation

Ash Atlas uses one server-authoritative combat engine for player-versus-environment and
player-versus-player combat. WebSocket handlers accept intent only. Damage, range, cadence, health,
mob stats, ownership, and hit outcomes are resolved by the server's existing 20 Hz simulation.

## Timing and ordering

- One server tick is 50ms at the default 20 Hz rate.
- The 1,600ms basic attack interval is 32 ticks.
- Player and enemy phases are offset by 800ms; each side's recurring opportunity remains 1,600ms.
- Every ordinary mob uses the owning PvE session's bounded enemy queue. One enemy opportunity scans
  each queued mob at most once, resolves at most one attack, skips out-of-range mobs in queue order,
  and resolves no attack when none are in range.
- A fresh in-range initiator attacks on the next simulation tick.
- An out-of-range initiator enters server-owned chase movement and attacks after entering 40m.
- A capable target retaliates 16 ticks after the initiating hit.
- Cooldowns survive cancel/restart and target switches. Repeated or duplicate Attack requests do not
  grant extra hits.
- Class abilities and Taunt never move the next scheduled basic-attack tick. Empower actives arm one
  transient effect that is consumed by the next normal basic at its existing deadline.
- Due work is ordered by scheduler sequence and stable entity identity. Entity life/combat revisions
  invalidate stale work, and a defeated actor cannot resolve later same-tick damage.

## Runtime architecture

`CombatEngine` owns in-memory combatants, engagements, dirty state, events, a 128m spatial hash,
and one due-tick scheduler. The scheduler handles attacks, player respawns, and future status expiry
without per-entity timers. Lethally damaged mobs leave combat state and the spatial hash immediately.
Player chase destinations feed the existing authoritative
movement leash; mobs use the same combat transitions and bounded home leashes.

Clients receive initial nearby `PLAYER_SNAPSHOT` and `COMBAT_SNAPSHOT` messages, followed by
`PLAYER_DELTA` batches at 20 Hz and `COMBAT_DELTA` batches at 10 Hz. The simulation remains 20 Hz. Recipients are
grouped by spatial cell so neighboring candidate sets are computed once per occupied recipient cell
and then distance-filtered for each player. Distant players, mobs, and events are not sent. The client stores this stream in a
Map-based combat store outside ordinary React state. Pixi retains dynamic player/mob display objects
by entity ID and updates them in place. Remote player positions use independent bounded authoritative
sample timelines about 150ms behind server time, so 20 Hz movement deltas animate continuously on
browser frames without restoring full-region snapshots or letting one underflowed track pause another.
The owning player uses only the latest sent movement target for bounded visual anticipation at the
server-advertised speed. That presentation can lead current authority by at most one advertised server
tick; gameplay position remains authoritative, with no input queue, rollback, or replay.

## Persistence

Migration `0012_basic_combat.sql` creates `player_combat_profiles`, keyed to the authenticated player.
Only maximum health, current health, and base damage are durable. Active combat, targets, chase
destinations, scheduled work, and development mobs are never persisted. Dirty profiles are batched
on the existing five-second persistence cadence. Migration `0013_combat_runtime_hardening.sql`
adds a durable monotonic persistence version so an older pass cannot overwrite newer health.
Failed batches stay dirty for bounded retry. No PostgreSQL operation occurs in attack resolution.

High-frequency movement, combat, and development-spawn requests enter a bounded typed world-command
queue. The central tick drains a configured maximum in stable order before movement, spatial sync,
scheduled combat work, and bounded replication. WebSocket callbacks do not resolve attacks or move
combat chases directly.

## Development mobs

Training Dummy is stationary and never retaliates. Goblin retaliates, moves, uses the universal
1,600ms same-side cadence with an 800ms alternating phase offset, and abandons targets beyond its home leash. `DEV_SPAWN_MOB` and `DEV_CLEAR_MOBS` are
accepted only when server configuration enables developer tools; production configuration rejects
developer tools before startup and the WebSocket path checks the setting again.
