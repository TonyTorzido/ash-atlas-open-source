# Portals and interiors

This page is the Build Bible entry point for enterable locations. The authoritative runtime architecture and invariants live in:

`docs/architecture/UNIVERSAL_PORTAL_AND_LOCATION_SYSTEM.md`

Read that document before changing an entry, exit, room, floor, cave, dungeon, shop, Salon, Manor, or similar space. This guide does not define a competing system.

## Model

A **location instance** is the whole place the player occupies: one Manor, Salon, shared sewer, dungeon run, cave, shop, or building. Its stable identity is `(locationType, locationId, instanceId)`.

A **space** is one room, floor, chamber, or independently rendered area within that instance. Moving between spaces changes `spaceId` and local position while preserving `instanceId`, domain session, player identity, inventory, equipment, combat state, party state, and exterior return data.

Current examples include `manor_main_room`, `salon_main_room`, `hatch_landing`, and `overflow_channel`. `manor_foyer` remains a compatibility-only saved location and is not part of the active Manor route.

A **portal** is a directed graph edge between a source endpoint and a destination endpoint. The current `PortalDefinition` in `packages/shared/src/locations.ts` contains:

- stable `portalId`;
- source and destination endpoints;
- exact source approach and threshold positions;
- exact destination arrival position;
- optional paired portal ID;
- interaction label;
- transition presentation;
- optional access policy and preload scene key;
- enabled state;
- opaque revision.

Reverse travel is a separate definition because approach and arrival transforms may differ.

A world doorway or hatch belongs to the canonical spatial package containing that exact portal anchor. Its `regionCode` must not be copied from an administrative city, structure owner, or nearby building center; adjacent spatial packages remain valid world portal destinations.

## Required interaction sequence

```text
click portal object
→ canonical compact action prompt opens
→ player chooses the supplied action
→ prompt closes
→ USE_PORTAL starts authoritative approach
→ destination preloads while the source remains visible
→ player reaches the exact threshold
→ brief transition cover
→ canonical location and space commit
→ the same player appears at the paired arrival anchor
```

The UI displays supplied portal presentation and action data. It does not implement or branch on world-to-interior, interior-to-world, room-to-room, floor-to-floor, or chamber-to-chamber transfer behavior.

The action prompt is gone before `USE_PORTAL` is sent. The universal portal controller owns the pending, busy, failure, and cancellation states; a feature must not keep its own `Entering...` latch that can strand or cover the canonical transition.

Before commit, a new manual movement intent cancels the entire portal action through the universal controller before sending the replacement movement. Cancellation must stop the authoritative approach, keep the source location canonical, ignore or cancel a late plan, and prevent the destination from mounting. Clearing only the prompt or a feature-local flag is not cancellation.

## Current implementation status

The universal runtime is implemented for Manor, Salon, Cistern Warrens, and catalog-defined dungeons. Active spaces include the Manor main room, Sewer entrance/depths, and authored dungeon rooms. The Manor foyer remains saved-location compatibility only.

Shared contracts and protocol:

- `packages/shared/src/locations.ts`
- `packages/shared/src/protocol/portalMessages.ts`
- `packages/shared/src/protocol/portalSchemas.ts`
- `packages/shared/src/protocol/portalServerSchemas.ts`
- `packages/shared/src/protocol.ts`

Client:

- `apps/client/src/client/domains/portalClient.ts`
- `apps/client/src/features/locations/usePortalLocationController.ts`
- `apps/client/src/features/locations/PortalTransitionOverlay.tsx`
- `apps/client/src/features/locations/LocationSceneHost.tsx`

Server:

- `apps/server/src/realtime/handlers/portalHandler.ts`
- `apps/server/src/game/locations/portalRegistry.ts`
- `apps/server/src/game/locations/ashAtlasPortalRegistry.ts`
- `apps/server/src/game/locations/portalTransitionCoordinator.ts`
- `apps/server/src/game/locations/playerLocationService.ts`

`PlayerLocationSnapshot` is canonical location authority. `PortalTransitionCoordinator` owns ordering, idempotency, readiness, threshold gating, durable compare-and-swap commit, cancellation, and reconnect interpretation. `PortalRegistry` and `ashAtlasPortalRegistry.ts` own validated static/dynamic portal definitions. `LocationSceneHost` selects the rendered environment from canonical location and space.

Legacy Manor, Salon, and Sewer domain messages remain compatibility projection calls only. They are not authorization to add feature-specific entry or exit pipelines. New callers use `USE_PORTAL`.

Those compatibility projections may mutate only their domain session or encounter state. They must not approach or move the actor, transfer spaces, restore a world position, change spatial membership, or swap scenes.

Current registered interior location types are `manor`, `salon`, `cistern_warrens`, and `dungeon`. Dungeon definitions resolve through `ashAtlasPortalRegistry.ts` and the `dungeon/*` scene provider. Adding another type extends the universal contracts and adapters; it does not create another pipeline.

## Feature responsibilities

Feature code may own access rules, locks, party or encounter gates, Manor guests/storage/smithing, Salon editor state, dungeon encounters and loot, scene content, and local-coordinate movement adapters.

Feature code must not own entry approach, location commit, region transfer, return-position restore, replication transfer, scene swap, reconnect interpretation, or replacement player identity.

On interior reconnect, canonical location is sufficient to mount the matching scene and restore its feature projection. The scene must not wait for a world-only player snapshot. Every feature wire schema that carries an actor must preserve the canonical appearance snapshot so reconnect cannot replace the player with a fallback marker.

## Forbidden implementations

- Feature-specific entry or exit pipelines
- A building-center radius used as its doorway
- A second click after reaching a portal
- A scene swap while the player stands in open space
- A fake interior player or separate interior inventory
- CSS-only world hiding used as location authority
- A top-level dungeon Exit button bypassing the portal object
- Room travel implemented as leaving and recreating the location
- Direct feature entry/exit messages used instead of `USE_PORTAL`
- A fourth legacy pipeline for new enterable content

## Adding a place or space

Follow the architecture document. In summary: extend the shared location contract, define stable space IDs and anchors, register directed paired portals and revisions, register the scene provider and preload readiness, supply policy and movement adapters, reuse capability profiles, render the canonical actor, and use `USE_PORTAL`.
