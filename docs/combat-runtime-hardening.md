# Combat Runtime Hardening

## Tick ownership

`WorldRuntime` is the single production tick owner. Each 20 Hz tick performs these stages in order:

1. Drain at most `WORLD_COMMANDS_PER_TICK_MAX` typed commands.
2. Advance the authoritative combat tick and update bounded chase intents.
3. Advance existing authoritative player movement.
4. Synchronize player positions and zone membership into combat and the spatial grid.
5. Resolve due attacks, respawns, and future lifecycle work; lethal mobs finalize only after durable
   reward-candidate acceptance.
6. Build dirty state and events.
7. At 20 Hz, build one shared per-cell AOI frame and flush movement replication; flush combat
   replication at 10 Hz.
8. Leave durable dirty profiles for the independent bounded persistence cadence.

The command queue has global and per-player limits, stable sequence ordering, duplicate retention,
a maximum drain budget, stale-authority rejection, and explicit overflow errors. Durable inventory,
harvesting, flags, and account transactions do not pass through this high-frequency queue.

## Replication and backpressure

Movement no longer broadcasts a complete region every 50ms. Initial connection and resync use full
nearby snapshots. Normal player state uses 20 Hz upsert/removal deltas; movement-only upserts omit unchanged
names, colors, anchors, and leash data. Combat and movement share a spatial-cell AOI frame. Candidate
cell sets are reused by recipients in the same cell and then circularly filtered per exact position.

Replaceable movement/combat state is skipped while a socket exceeds the soft buffered-data limit.
The recipient is marked for a current full snapshot, so intermediate state is coalesced rather than
queued. A socket that remains slow or crosses the hard limit is closed. Critical acknowledgements are
never treated as replaceable.

Combat and player deltas are monotonic per recipient. Duplicate and old deltas are ignored. A gap is
not applied: the client sends rate-limited `REQUEST_WORLD_RESYNC`, and the server replies with current
nearby player and combat snapshots. Reconnect clears the client sequence epoch before its snapshots.
The retained Pixi player objects consume bounded timestamped position histories on every animation
frame. Each remote player stays about 150ms behind authoritative server time to interpolate 20 Hz
movement samples, pauses at its newest sample instead of extrapolating, and uses bounded catch-up
after delayed packets without pausing other tracks. The owning player starts a latest-request-only
visual anticipation on send at the server-advertised speed, capped to one advertised server tick ahead
of current authority. Rejections and authoritative stops converge within one tick. Ordinary ordered
samples interpolate regardless of distance. Explicit visits, teleports, respawns, and anchor, region,
or zone changes still snap immediately. Gameplay remains server-authoritative; there is no saved input
queue, rollback, command replay, or unbounded prediction.

## Lifecycle and persistence

Attack work is represented by one due-tick cooldown slot per actor. The slot and lifecycle generation
checks make stale work harmless after cancellation, target changes, defeat, respawn, removal,
disconnect, replacement, teleport, flag visits, zone changes, and development cleanup. Scheduler
buckets are not scanned to cancel work; stale entries are discarded when due.

Combat profile writes are versioned in PostgreSQL, batched with bounded concurrency, and single-flight
at the runtime cadence. Successful versions clear only the matching dirty in-memory revision. Failed
batches remain dirty for retry, and a bounded final flush runs during shutdown. Combat resolution has
no profile-write dependency; reward-bearing defeat finalization uses the durable boundary below.

Mob defeat creates one `CombatDefeatSettlementCandidate` containing a stable settlement key, defeat
generation, tick, archetype, eligible players, and damage contributions. A lethal mob enters a
non-attackable, non-final state while that raw candidate is inserted into PostgreSQL. Successful
durable acceptance finalizes kill effects and removes the mob from active combat, AOI, and the spatial
grid. An acceptance outage restores one health instead of pretending that the reward-bearing defeat
settled.

The durable inbox has no process-capacity rejection boundary. Two bounded workers claim eligible rows
with `FOR UPDATE SKIP LOCKED`, processing leases, attempt timestamps, exponential backoff, and restart
reconciliation. Preparation and participant rows are transactional. XP and class mastery grants retain
stable per-player operation keys, so crashes during preparation, either grant, or final status update
replay without duplicate rewards. Metrics expose durable queue depth, oldest pending age, processing,
retry, failure, and completed counts.

## Outstanding manual QA

Use separate authenticated browser profiles for the first two cases so newest-connection replacement
does not intentionally evict the other player.

1. Two-account PvP: place both players within 40m, attack once, verify initiator first and retaliation
   800ms later; repeat from outside range and verify the approach stops near 38m.
2. Disconnect timing: close the initiator before its first due hit, then repeat while retaliation is
   pending. Verify no stale damage after disconnect.
3. Refresh/replacement: refresh during combat, then open a second tab with the same account. Verify the
   old lease closes, snapshots replace local state, and no old target resumes.
4. Lifecycle: Visit Flag and developer-teleport during a chase. Verify combat cancels before another hit.
5. Sequence recovery: in browser network tooling, drop one `COMBAT_DELTA` or `PLAYER_DELTA`; verify a
   `REQUEST_WORLD_RESYNC` is followed by both authoritative snapshots and no ghost entity remains.
6. Mobile: test 390x844 with target prompt, health bars, Mob Spawner, and map drag/zoom while fighting.
7. Dense visual smoke: fight while rapidly dragging and zooming; verify retained objects interpolate
   without camera snapping, static-overlay churn, or browser/server errors.
