# Universal Portal and Location System

All enterable places use one durable player-location model and one portal transition coordinator. Manor, Salon, Cistern Warrens, and dungeons retain their domain behavior, but they do not own competing entry, exit, or scene-swap pipelines.

## Location instance and active space

A location instance is the whole place the player occupies: a specific Manor, Salon, shared sewer, or dungeon run. Its stable identity is `(locationType, locationId, instanceId)`. A space is one independently rendered room or floor within that instance and is identified by `(instanceId, spaceId)`.

A room transition changes `spaceId` and local transform while preserving `instanceId`. It must not recreate the domain session, inventory, equipment, combat profile, party, encounter state, or exterior return data.

Current examples:

| Instance | Spaces |
| --- | --- |
| `manor:<manorId>` | `manor_main_room` (`manor_foyer` is retained only for saved-location compatibility) |
| `salon:<structureId>` | `salon_main_room` |
| `sewer:<structureId>` | `hatch_landing`, `overflow_channel`, `turtle_cistern`, `warden_junction`, `webbed_tunnels`, `brood_chamber` |

Dungeon instance IDs follow the catalog's instance policy in `ashAtlasPortalRegistry.ts`; authored room IDs become `spaceId`, and `LocationSceneHost` resolves their `dungeon/*` scene provider.

There is no architectural depth limit. More rooms are additional graph nodes and edges in the same instance.

## Canonical player location

`PlayerLocationSnapshot` is the single answer to whether a player is in the world or an interior, their instance and active space, authoritative position, spatial membership, scene, capabilities, and reconnect destination. The `players` row durably stores that state with a monotonic `location_revision` and the last idempotent transition identity.

Feature presence tables remain projections for Manor access/session, Salon editing, and sewer encounter state. They are not location authority. Bootstrap reads canonical location first, restores only its matching feature projection, and safely ejects an invalid interior reference.

For spatial membership:

- world locations use the normal geographic region and zone;
- a world portal anchor derives `regionCode` from the canonical spatial package containing that exact anchor, not from an administrative city, structure owner, or building center; adjacent spatial packages are valid;
- an interior `regionCode` is `interior:<instanceId>`;
- an interior `zoneId` is `interior:<instanceId>:<spaceId>`.

Instance runtimes can see all occupants, while ordinary occupant replication is limited to the active space.

## Portal graph

A `PortalDefinition` is a directed graph edge with explicit source and destination endpoints. It includes exact source approach and threshold transforms, exact destination arrival, an optional reciprocal portal, an opaque revision, access policy, scene preload key, presentation, label, and enabled state.

World endpoints use structure-relative doorway or hatch anchors. A structure center or saved-radius return point is not a normal portal anchor. Interior endpoints use exact local coordinates. Reverse travel is its own definition because its approach and arrival transforms may differ.

`PortalRegistry` validates coordinate kinds, reciprocal static edges, source space, and same-location instance preservation. Dynamic Ash Atlas definitions resolve current structure placement and revision from retained data.

## Authoritative transition flow

The generic wire flow is:

1. The object click opens the normal action prompt.
2. The chosen action closes that prompt and sends `USE_PORTAL` with request, portal, and expected location/revision identity.
3. The server resolves and authorizes the portal and creates one active transition for the player.
4. `PORTAL_TRANSITION_PLANNED` starts destination preload while the source remains visible.
5. The source movement adapter moves the authoritative actor to the exact threshold.
6. The client sends `PORTAL_DESTINATION_READY`; a bounded fallback prevents indefinite waiting.
7. Only readiness plus authoritative threshold arrival permits the durable compare-and-swap commit.
8. The scene changes under a brief presentation cover and the actor appears at the paired arrival anchor.
9. `PLAYER_LOCATION_SNAPSHOT` installs the committed canonical destination.

The coordinator owns ordering, idempotency, stale-revision rejection, cancellation, readiness gating, durable commit, generic transition effects, final location publication, and reconnect interpretation. Movement adapters only approach and stop in their coordinate system. Destination adapters only authorize and project feature state.

The client closes the action prompt before sending `USE_PORTAL`. Pending, busy, failure, and cancellation presentation belongs to the universal portal controller; feature-owned `Entering...` latches are forbidden because they can outlive or obscure the canonical transition.

Legacy Manor, Salon, and Sewer entry/exit messages are compatibility-only domain projection calls and are rejected as external transition requests. New callers must use `USE_PORTAL`.

Compatibility projections may mutate only domain session or encounter state. They must not move the actor, transfer spaces, restore a world position, change spatial membership, or swap scenes.

## Commit, failure, and reconnect rules

Before durable commit, cancellation, failure, or disconnect stops movement and leaves the source location canonical. After durable commit, the destination is final even if a client disconnects or a feature projection fails; reconnect repairs the runtime projection from canonical state. A repeated request identity is a replay, while reuse with different content fails.

A new manual movement intent before commit is universal cancellation: the client cancels the active transition before sending replacement movement. If movement is chosen after `USE_PORTAL` but before `PORTAL_TRANSITION_PLANNED` arrives, the client records that request as cancelled and immediately sends `CANCEL_PORTAL_TRANSITION` when its late plan supplies the transition identity. The late plan must never preload into a destination mount, reopen a prompt, or survive as feature-local pending state.

Interior reconnect mounts from canonical location and restores only the matching feature projection; it must not wait for a world-only player snapshot. Any protocol projection carrying an actor preserves the canonical appearance snapshot so reconnect cannot degrade the actor to a fallback marker.

The database compare-and-swap prevents a stale client revision from overwriting a newer location. The coordinator's generic transition effects remove the old replication membership and install the destination exactly once. Same-instance transitions only update local position, active space, and zone membership.

An unavailable retained instance uses an explicit safe-ejection path. Destruction, forced Manor ejection, death, and respawn must choose a defined canonical portal or recovery anchor rather than inventing an unrelated coordinate.

## Client shell, scenes, actor, and capabilities

The permanent application shell owns realtime, canonical player stores, inventory, equipment, appearance, health, progression, abilities, cooldowns, party, chat, HUD, location, and portal controller. `LocationSceneHost` changes only the environment provider selected by canonical location and space.

The world renderer is suspended while an interior is canonical. The source scene remains mounted during approach; cover begins only at the threshold/commit boundary. Development-only performance marks record request, plan, preload, threshold, commit, mount, and reveal phases.

Interior scenes render the canonical `PlayerRenderer` through a coordinate adapter. Remote room occupants carry authoritative appearance and render only in their active space. Features must not create a replacement player identity or procedural feature-only body.

`WORLD_LOCATION_CAPABILITIES` and `INTERIOR_LOCATION_CAPABILITIES` describe which HUD actions are available. Disabled actions hide or disable without destroying their underlying stores. Add a space-specific override only when behavior genuinely differs inside one location type.

## Feature adapter responsibilities

Feature code may own:

- access, locks, party gates, and encounter gates;
- Manor guests, storage, smithing, bans, and ejection policy;
- Salon editor state;
- dungeon enemies, loot, health, locks, bosses, and encounter progress;
- scene content and local-coordinate movement.

Feature code must not own an independent entry approach, location commit, return-position restore, replication transfer, scene swap, or exit protocol. It must not rebuild player identity or durable gameplay stores on a room transition.

## Adding an enterable place or space

1. Add its location type and instance policy to the shared location contract.
2. Define stable space IDs and exact local arrival anchors.
3. Register directed, paired portal definitions with revisions and real exterior anchors.
4. Register scene providers in `LocationSceneHost` and implement preload readiness.
5. Supply access/destination policy and an appropriate movement adapter.
6. Define or reuse capability profiles.
7. Render the canonical actor and authoritative occupant appearances.
8. Use `USE_PORTAL`; do not add feature-specific entry/exit messages or scene-swap state.

Doors may be disabled, one-way, locked, party-gated, or boss-gated through portal content and authorization. Do not implement a parallel transfer algorithm.

Manor Studio publishes its paired room anchors as `manor:<manorId>:room:<roomId>:<anchorId>`
through the same registry. The default room retains the `manor_main_room` compatibility space;
hallways and downstream rooms use their authored IDs within that same Manor instance. A locked
anchor disables its directed portal without disabling the reciprocal return. Both movement and
arrival anchors must be walkable; painted door polygons can extend beyond the floor. Room PNGs
are optional: unillustrated rooms use a shared labelled layout preview until art is uploaded.
Studio Walk Test simulates the authored graph; it does not replace live portal authorization.

## Focused testing checklist

- Validate portal coordinate shapes, reciprocal endpoints, graph references, and revisions.
- Cover each current world boundary and exact exterior arrival.
- Cover Manor world/main in both directions, legacy foyer recovery, and Sewer entrance/depths in both directions.
- Prove same-instance changes preserve instance/session and do not rebuild combat or inventory state.
- Cover unauthorized, disabled, stale, duplicate, cancellation, and readiness cases.
- Cover disconnect before and after commit and reconnect restoration.
- Verify one spatial space membership and same-room occupant filtering.
- Verify source visibility during approach, preload readiness, brief cover, destination mounting, and no second click.
- For schema changes, verify populated upgrade, preserved Manor/Salon/Sewer rows, and an empty second migration run on disposable PostgreSQL.
