# Ash Atlas Preferred Web Stack and Multiplayer Architecture

**Status:** Preferred direction  
**Project:** Ash Atlas  
**Primary repos:**  
- `world-pipeline` = geography/environment compiler and world API  
- `game` = actual game runtime/client/server  

---

## Decision

Ash Atlas should continue with the **web stack** for the playable game:

```text
React / Vite      = UI, HUD, panels, inventory, kingdom screens
MapLibre          = real-world map rendering
PixiJS            = players, flags, circles, sprites, effects
WebSockets        = live multiplayer updates
Fastify / Node TS = authoritative game server and API
Postgres/PostGIS  = durable game + geospatial persistence
Redis later       = presence/routing/pubsub, not durable truth
```

Do **not** switch to Unity right now.

Do **not** switch to a weird experimental backend stack.

The hard part for Ash Atlas is not the client renderer. The hard part is:

```text
server authority
movement validation
territory rules
battle zones
siege ticks
interest management
anti-cheat
smooth multiplayer sync
```

The current web stack can support the game if the server stays authoritative and the realtime/battle architecture is designed cleanly.

---

## Core rule

```text
Client is dumb.
Server is truth.
```

Clients send **intents**:

```text
MOVE_TO
PLACE_FLAG
VISIT_FLAG
ATTACK
USE_ABILITY
JOIN_BATTLE
LEAVE_BATTLE
```

The server decides:

```text
is the action valid?
is the player close enough?
is the target inside range?
is the cooldown ready?
is the flag placement allowed?
who should receive the update?
what gets persisted?
```

The client should never decide final movement, combat, flag placement, ownership, resources, or siege progress.

---

## Why web stack is still the right direction

Ash Atlas is not mainly:

```text
full 3D
physics-heavy
animation-heavy
controller-first
native mobile-first
traditional action RPG camera
```

Ash Atlas is mainly:

```text
real map location gameplay
flags and territory
players grouping around real-world locations
kingdoms/houses
sieges
server-controlled battle zones
30–60+ players in one circle
```

The best immediate stack is therefore not Unity. It is a browser client plus a professional authoritative server.

Unity can still become a second client later if the game proves itself, but switching now would slow the project without solving the hardest problem.

---

## Recommended long-term architecture

```text
Browser Client
  React / Vite
  MapLibre
  PixiJS
  WebSocket client
        |
        v
Realtime Gateway
  TypeScript initially
  current WebSocket/Fastify-compatible layer now
  uWebSockets.js-compatible abstraction later if needed
        |
        v
Authoritative Game Server
  Fastify HTTP API
  game services
  validation
  persistence boundaries
        |
        v
Zone / Battle Workers
  one worker owns one active battle circle
  fixed tick loop
  in-memory live battle state
  compact snapshots/events
        |
        v
Storage / Coordination
  Postgres/PostGIS = durable truth
  Redis later = presence/routing/pubsub only
```

---

## Current stack to keep

### Client

```text
React + Vite
MapLibre
PixiJS
TypeScript
```

Responsibilities:

```text
React:
  HUD
  menus
  inventory
  flag panels
  kingdom/house panels
  debug panels

MapLibre:
  base map
  map camera
  zoom/pan
  real-world map display

PixiJS:
  player sprites
  flags
  territory circles
  movement circles
  combat effects later
  animated units/mobs later
```

Important render lesson from local testing:

```text
Keep the stable Pixi overlay path.
Do not move flag/territory/leash rendering to MapLibre right now.
Do not throttle visible territory/flag rendering to low FPS.
```

The MapLibre static-overlay migration felt bad and tested worse. It should remain out of the codebase unless a future controlled experiment proves otherwise.

### Server

```text
Node.js
TypeScript
Fastify
WebSockets
Postgres/PostGIS
```

Responsibilities:

```text
HTTP:
  health/ready
  flags
  players
  dev/admin tools
  persistence APIs

WebSocket:
  player session
  movement intents
  player snapshots
  flag events
  future battle events

Game services:
  movement validation
  flag validation
  territory rules
  player state
  future resource/building/combat rules
```

---

## Data authority

### Postgres/PostGIS

Postgres/PostGIS is the durable source of truth for:

```text
players
flags
territory ownership
buildings
inventory
resource balances
settlements
battle results
audit/history
world/environment snapshots
```

PostGIS is the right long-term geospatial persistence tool because Ash Atlas is fundamentally a real-map game.

### In-memory zone/battle state

The live state of a fight should be owned in memory by one authoritative process/worker.

During combat ticks, do **not** query Postgres/PostGIS every tick.

Do this instead:

```text
load battle setup
run combat in memory
accept player intents
validate range/cooldowns/position
broadcast snapshots/events
persist results asynchronously or at battle checkpoints
```

### Redis later

Redis should be added later for:

```text
presence
routing
which server owns which zone
cross-process pub/sub
online player lookup
ephemeral coordination
```

Redis should **not** be the durable game truth.

Redis Pub/Sub is okay for ephemeral messages, but not for critical durable events because missed Pub/Sub messages are gone.

---

## Multiplayer model for 60+ player wars

A 60-player flag war should be treated as a **zone** or **battle room**:

```text
battle_zone_<flagId>
```

One authoritative worker owns that battle zone.

Players in that zone receive zone updates. Players outside that zone do not need every update.

### Tick model

Initial target:

```text
server simulation tick: 20 Hz
snapshot broadcast: 10–20 Hz
client render: 60 FPS where possible
client interpolation buffer: ~100–150 ms
```

The server tick should be lightweight:

```text
for each tick:
  read queued intents
  validate actions
  update in-memory player/battle state
  create compact snapshot/events
  broadcast to interested clients
```

Avoid:

```text
DB queries in hot tick
PostGIS geometry work in hot tick
giant JSON world snapshots
global broadcasts
client-authoritative combat
expensive synchronous CPU work
```

### Interest management

Send updates only to players who need them:

```text
same battle circle
nearby area
same flag/territory context
same party/house/kingdom channel later
```

Do not broadcast one player’s movement to the whole world.

### Expected 60-player viability

60 players in one circle is not automatically scary.

What matters is discipline:

```text
compact messages
no DB in tick
server-authoritative validation
one battle owner
interest-group broadcasts
client interpolation
```

If the server is clean, this stack should handle 60-player battle tests before requiring a major language rewrite.

---

## Realtime transport plan

### Now

Use the current WebSocket setup.

Keep messages typed and validated.

JSON is fine for now.

### Soon

Wrap the realtime transport behind a small interface:

```text
connection.send(message)
connection.close()
gateway.broadcastToZone(zoneId, message)
gateway.onMessage(handler)
gateway.onConnection(handler)
gateway.onDisconnect(handler)
```

Game code should not care whether the underlying transport is:

```text
ws
Fastify websocket
uWebSockets.js
```

### Later if needed

If profiling shows the WebSocket transport itself is a bottleneck, upgrade the realtime gateway to **uWebSockets.js**.

Do not switch early. Make the transport swappable first.

---

## JSON vs binary protocol

Use JSON now.

JSON is good for:

```text
early WebSocket messages
debugging
typed protocol development
tooling
logs
F1/F2/F3 debug work
```

Move hot paths to binary only when metrics prove it is necessary.

Possible future progression:

```text
Phase 1: typed JSON + Zod
Phase 2: compact JSON fields
Phase 3: MessagePack or custom binary for battle snapshots only
```

Do not prematurely convert the entire game protocol to binary.

---

## What not to do now

Do not do these yet:

```text
Unity rewrite
Nakama migration
Go/Rust rewrite
custom binary protocol everywhere
MapLibre overlay migration
static overlay throttling
global world snapshots
database-in-combat-tick architecture
real auth before multiplayer presence
combat before player persistence/presence
```

---

## Possible future stack upgrades

### uWebSockets.js

Use if WebSocket transport overhead becomes a real bottleneck.

Keep the game server TypeScript code. Swap only the transport/gateway layer.

### Redis

Use once multiple server processes exist.

Good for:

```text
presence
routing
pub/sub
zone ownership lookup
```

Not good as the durable source of truth.

### Go or Rust battle workers

Only consider if profiling proves Node/TypeScript simulation is CPU-bound.

The future shape could be:

```text
TypeScript gateway + API
Go/Rust battle worker for very hot zones
Postgres/PostGIS persistence
Redis routing
```

Do not start here. Add it only when there is a real bottleneck.

### Nakama

Nakama is a legitimate game backend, but it is not the preferred current path.

Reasons:

```text
Ash Atlas has custom real-map/PostGIS territory logic.
The current TypeScript server is already moving fast.
Adopting a full game backend could fight the custom architecture too early.
```

Keep it as a future reference, not the current direction.

### Unity

Unity may become a second client later.

Do not replace the current browser client/server stack now.

---

## Next recommended milestone

### G2: Multiplayer Presence Foundation

Build this before resources, buildings, and combat.

Scope:

```text
players table
persistent player profile
persistent last location
persistent anchor/location state
multiple browser clients
other players visible on map
player name labels
online/offline presence
connection cleanup
reconnect restores player
basic zone/interest model
```

Acceptance test:

```text
Open browser A as Avery.
Open browser B/private window as TestPlayer.

Both spawn.
A sees B.
B sees A.
A moves; B sees A move.
B moves; A sees B move.
A builds flag; B sees flag.
Refresh A; A keeps identity/location.
Close B; B disappears or becomes offline after timeout.
```

No combat yet.

No resources yet.

No buildings yet.

The purpose of G2 is to make every future system multiplayer-shaped.

---

## G2 implementation notes

The first G2 implementation keeps the current web stack and stable Pixi render path.

Implemented foundation:

```text
players table
HELLO get/create player flow
durable player location and movement anchor
durable player display_color for flag/territory ownership color
online/offline presence
canonical one-degree package zones with 3x3 neighboring interest membership
date-line-safe server-authoritative zone transitions
multiple same-player dev tabs allowed
other players rendered with lightweight name labels
```

Persistence model:

```text
Postgres stores durable player truth.
The server hydrates in-memory movement state from Postgres on HELLO.
Movement ticks stay in memory.
Dirty player snapshots are persisted periodically, not every tick.
Visit Flag, dev teleport, disconnect, and shutdown persist immediately.
```

Transport model:

```text
The current Fastify WebSocket transport remains.
The connection registry now tracks connection id, player id, username, region, zone,
connected time, and last message time.
Region/zone broadcast helpers are present so future battle rooms can be introduced
without scattering raw socket iteration through game logic.
```

Flag and territory color model:

```text
players.display_color is durable profile data.
Flag snapshots include ownerColor by joining flags to players.
Changing a player color broadcasts fresh player and flag snapshots.
Existing flag rows are not rewritten for color changes.
```

Territory boundary model:

```text
Server remains authority for flag placement and ownership.
Client Pixi rendering uses owner colors.
Same-owner claim circles still merge.
Opposing-owner claim circles are visually clipped against midpoint/perpendicular
bisectors so territories meet at shared borders instead of drawing over each other.
The server resolver uses lat/lon meter distances for gameplay authority:
open land has no owner, same-owner claims merge, and contested opposing overlap
belongs to the nearest flag owner with deterministic flag-id tie breaks.
Client clipping is visual; the resolver decides build placement and future
siege/combat/resource ownership checks.
GET /api/territory/resolve?lat=...&lon=... exposes that authoritative answer
for local debugging and QA.
```

Still intentionally not included:

```text
real auth
Redis
combat
resources
buildings
kingdoms/houses
production deployment
```

---

## G3 ambient spawn model

G3 keeps the core multiplayer rule:

```text
Client is dumb.
Server is truth.
```

The game now has environment-derived ambient collectible nodes. Resource generation is a cold
background job keyed by flag Resource Vision; it is never client-generated and never generated by
walking. `VISIT_FLAG` is a hot gameplay action and should not wait on World API/PostGIS generation.

Authority split:

```text
World API
  describes biome, terrain, elevation, land/water, major rivers, and lakes

Game server
  owns flag Resource Vision prewarm jobs
  generates deterministic candidates
  persists vision status, nodes, and inventory
  validates pickup and water collection distance

Client
  renders Pixi markers
  sends visit/pickup/list/water intents only
```

Flag Resource Vision activates nearby spawn cells:

```text
spawn cell size:        250m
resource vision:       movement leash radius + 250m, anchored to the visited flag
cell inclusion:        250m cells intersecting the resource vision circle
visible node radius:   exact distance from the active flag center
pickup/water radius:   50m
visible node cap:      150 nearest available nodes per client snapshot
```

Each flag has a `flag_resource_visions` status row: `pending`, `generating`, `ready`, or `failed`.
Creating a flag queues a background prewarm. Visiting a ready flag sends an immediate snapshot.
Visiting an unready flag moves the player immediately, sets the active Resource Vision, sends a
loading/surveying event, and queues or joins the background job. When the job completes, the server
sends `RESOURCE_VISION_READY` and a small `COLLECTIBLES_SNAPSHOT` to the player if that flag is
still the active vision.

The server calls the World API once per new spawn cell, stores the environment snapshot, and uses
deterministic rules to choose wood, stone, food, and ore candidates. The base visible mix is roughly
wood 4, food 2, stone 2, and ore 1, with small deterministic variation; water is not spawned as a
ground node. The `spawn_cells` row is the permanent one-time marker. If a generated cell produces
zero nodes, that empty cell is still considered complete and is not retried. Visiting the same flag
again uses the persisted ready vision, and visiting a nearby flag creates only the missing cells for
that flag's Resource Vision. Spawned nodes can persist beyond the per-client cap; the cap only
limits the active flag snapshot and Pixi render workload. Harvested nodes stay harvested until an
explicit dev reset.

Water remains separate from random ground-node spawning. The client sends
`COLLECT_WATER_AT_COORDINATE`; the server checks that the coordinate is near the player and that the
existing World API profile clearly indicates collectible major water, such as major lake containment,
nearby major river distance, or saltwater. Tiny HydroRIVERS streams, arroyos, and visual debug layers
are not gameplay water in this runtime milestone. If the world-pipeline debug World API exposes
the Natural Earth collectible-water source endpoint, the game displays read-only water highlights
inside the active Resource Vision. If that endpoint is missing or unavailable, no highlights are
shown and water collection still works through the existing EnvironmentProfile lookup path.

Flags only decide when and where local area discovery happens. They do not decide which resource
types exist; the World API/environment snapshot still decides those. Walking, movement ticks,
`REQUEST_NEARBY_COLLECTIBLES`, and the legacy survey route return the active flag vision only; they
do not move the anchor, refill harvested nodes, or generate new cells. Later milestones can let
territory affect ownership, bonuses, access, depletion, or regeneration, but those rules should
modify this server-owned spawn system rather than moving authority to the client.

During drag/zoom, the client keeps Pixi overlay membership stale while the map transform changes:
old visible flags/resources/water highlights stay aligned, server-deleted or harvested objects can
still disappear, and newly visible static objects wait until move/zoom idle before being added. The
client does not query or generate resources during drag. Player movement and the movement leash
continue updating from the latest server snapshots.

---

## Recommended milestone order

```text
P0  Commit/push current stable game work
P1  G2 Multiplayer Presence Foundation
P2  G2.1 Dev/Admin multiplayer tools
P3  G3 Environment-derived resources
P4  G4 Inventory + gather action
P5  G5 Buildings on flags
P6  G6 Territory ownership/factions
P7  G7 Multiplayer presence polish / nearby players
P8  G8 Basic combat prototype
P9  G9 Siege/capture loop
P10 Water-source lookup integration
P11 USA/world expansion
```

---

## Engineering rules going forward

1. Server authority always.
2. Client sends intents only.
3. DB is not in the hot tick.
4. One battle zone has one live owner.
5. Only interested clients receive updates.
6. Postgres/PostGIS stores durable truth.
7. Redis later is ephemeral coordination only.
8. Keep render architecture stable unless a controlled branch proves better.
9. Profile before major rewrites.
10. Prefer small, reversible branches.

---

## References

These references support the selected stack direction:

- MDN WebSocket API: https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API
- Fastify: https://fastify.io/
- PostGIS: https://postgis.net/
- Redis Pub/Sub delivery semantics: https://redis.io/docs/latest/develop/pubsub/
- uWebSockets.js: https://github.com/uNetworking/uWebSockets.js

Local project evidence:

- The stable Pixi render path felt acceptable in manual testing.
- The MapLibre static-overlay migration felt bad and should not be used right now.
- The F2/F3 performance tools should remain as observability, not as an excuse for broad rewrites.
