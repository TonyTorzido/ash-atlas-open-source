# Dungeon Backend Contract

This contract defines the server authority for authored dungeons. Atlas Studio may author and
publish catalog data, but it does not own runtime movement, location, combat, rewards, or recovery.

## Authority boundaries

- World and dungeon entrances and exits use the universal portal system. A dungeon-specific entry or
  exit message must not move a player between world and interior locations.
- `PlayerLocationService` is the durable location authority. Portal transitions use its revision/CAS
  contract and retain the exact entrance, instance, room, and arrival position.
- `DungeonRuntime` owns the live room projection, navigation, encounters, authored object state,
  instance resets, and dungeon presence projection.
- Authored resource nodes and spawn zones are server-generated from the catalog, run identity, and
  zone seed. Harvesting checks the authoritative player position, grants through the inventory
  operation contract, and records depletion/respawn state by `(instance, run, resource)`.
- `item_owned` and `quest_flag` trigger/portal gates use production inventory and achievement
  authorities. Missing or failed authority reads deny the condition; Studio never supplies a
  client-side substitute.
- Dungeon boss templates reference registered `BossDefinition` and controller packages through
  the shared boss framework. A dungeon may configure placement and encounter settings, but cannot
  introduce a controller script or duplicate reward settlement code.
- Durable dungeon runs and presence rows are scoped by instance and run identity. Reconnect restores
  only when the durable projection matches the canonical location; otherwise the player is safely
  ejected and stale presence is removed.
- Authored object, portal-lock, flag, trigger, encounter, and resource state is forward-persisted in
  `dungeon_instance_state` and `dungeon_resource_states`; reset rotation changes the run identity so
  an older run cannot be resumed accidentally.
- Reward claims are idempotent at the `(run, player, reward source)` boundary and must settle through
  the durable reward authority before the client treats a reward as granted.

## Required invariants

Every published active dungeon must have:

1. an active world entrance binding and a world-to-room entrance portal;
2. an exact walkable arrival anchor and a walkable death-recovery anchor;
3. reciprocal portal endpoints with valid room anchors;
4. reachability from the entrance to every active room;
5. a recovery path from every active room to the world;
6. bounded trigger graphs with no cycles;
7. catalog and asset revisions that can invalidate stale client projections.

## Verification

Run the focused server dungeon suite from `apps/server`:

```text
pnpm vitest run src/game/dungeon.test.ts src/game/dungeonRewards.test.ts
  src/game/dungeonRuntimeMigration.test.ts src/game/locations/ashAtlasPortalRegistry.test.ts
  src/game/locations/portalTransitionCoordinator.test.ts
  src/realtime/handlers/portalHandler.test.ts src/realtime/handlers/dungeonHandler.test.ts
  src/realtime/handlers/sessionBootstrapRecovery.test.ts
```

Run the durable PostgreSQL tests with an explicitly disposable admin database named
`ash_atlas_stability`:

```text
pnpm test:postgres
```

The PostgreSQL matrix must fail closed when its disposable admin URL is absent. It must never point
at the retained `ash_atlas_game` database.
