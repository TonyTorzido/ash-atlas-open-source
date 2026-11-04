# Unified interior rooms

One room model, one Studio editor, and one navigation/interaction path for every interior
(Manor, dungeon/Cistern Warrens, Greenhouse, Salon). Rendering is covered by
`INTERIOR_MAP_RENDERER.md`; this document is its P5, pulled forward.

Owner decisions (2026-09-29):

- Manor's room-layout tools are the geometry standard for every room; keep the best of every
  system and add only must-have gaps.
- Studio: the DungeonStudio shell (undo/redo, prefab library, Simple/Advanced, validation,
  Play Test, topology, wizard) hosts Manor's canvas tools; it is renamed InteriorStudio.
- Players may drop items in every Manor room (one migration relaxes the drop `space_id` check).

## Capability decisions

| Capability | Standard |
|---|---|
| Walkable area | Manor floor polygons. Dungeon rooms convert to one rectangle floor inset by `playerRadius` so movement is unchanged. |
| Colliders | Dungeon rect \| polygon. |
| Wall surfaces | Manor back/left/right walls with UV mapping; optional on any room. Player placement only where the space enables the decoration module. |
| Anchors | Manor-style roles: `spawn \| portal \| message \| point`. Mobs, resources and objects reference `point` anchors. |
| Portals | Dungeon portal records (world\|room endpoints, approach/threshold/arrival, reciprocal, conditions, gates, presentation, enabled), authored with Manor UX: choosing a portal anchor's destination creates both records. Manor `locked` → `enabled:false`. |
| Click areas | Manor polygons, bindable to an anchor or an object; prefab bounds are the fallback. |
| Art | Dungeon layers + prefab placements with state art. Manor floor PNGs and greenhouse overlays become placements. |
| Objects | Dungeon typed objects + `station{stationKind: smith\|jewel\|breeder (the retired chest is gone from the Manor lobby)}`, `planter`, `water_tank`, `salon_chair`. |
| Gameplay modules | Dungeon encounters, triggers, reward tables/loot, resources, reset, bosses — optional modules, validated by space kind. |
| Player placements | Manor footprint + extra-collider rules in one shared function (decorations, pots). |
| Revisions/permanence | Manor rules everywhere: published ids are only retired, changed rooms/spaces need a new revision. |

Must-add gaps: authored world-exit portal in every space (Manor exit uses the 1000² profile door
at 830,830 inside a 1254² room; Greenhouse exit is hardcoded at 830,830 while Studio authors it at
627,1158); stations and the salon chair as objects; click areas on objects; one
`interiorNavigation(room, extraColliders)` replacing `manorTemplateRoomNavigation`,
`navigationProjection` (server dungeon.ts), `catalogRoomNavigation` (dungeonCatalog.ts),
`greenhouseNavigation` and `SALON_MAIN_ROOM`; a real `spatialProfileId: "dungeon" |
"standard_indoor"` (matching `interiorSpace.ts`; no coordinate rescale); `revision` on every room.

Not now: triggers/encounters in non-dungeon spaces and portal gates outside dungeons (schema
allows, validation rejects until a runtime exists); mandatory walls; more anchor roles; merging the
runtime classes.

## Schema

`packages/shared/src/interior/interiorCatalog.ts`; data in `packages/shared/src/data/interiors/`
(one JSON per space + `_library.json`) so worktrees don't conflict and Studio locks per file.

```ts
InteriorLibrary { schemaVersion: 1, catalogRevision, prefabs[], rewardTables[], bossTemplates[], entrances[] }
InteriorSpace {
  id, kind: "manor" | "dungeon" | "greenhouse" | "salon", revision, retired, name, description,
  spatialProfileId: "dungeon" | "standard_indoor", instancePolicy, defaultRoomId, environment,
  rooms: InteriorRoom[], portals: PortalRecord[],
  modules?: { encounters?, triggers?, reset?, escape?, deathRecovery?,        // dungeon only
              decoration?: { definitions, playerPlacement }, planters?: { capacity, potPrefabId, stageArt[] },
              salon?: {} }
}
InteriorRoom {
  id, revision, retired, active, name, width, height, spawnAnchorId, camera, environment,
  floors: { id, retired, polygon }[],                       // >= 1 when active
  walls: { id, retired, kind, roomPolygon, imagePolygon, transform }[],
  colliders[], zones[], layers{ background..ceiling }, anchors: { id, retired, x, y, facing?, role, message? }[],
  clickAreas: { id, retired, polygon, target: { anchorId } | { objectId }, interactionLabel }[],
  objects[], mobs[], resourceNodes?[], resourceSpawnZones?[]
}
```

Mappings (`interior/transforms.ts`, run once, output committed, ids preserved exactly):

- Manor template → space; `placementSurfaces` → `floors` + `walls` (same ids); `portalHotspots` →
  `clickAreas` (same ids); portal anchor pairs → two portal records; runtime portal id stays
  `manor:<id>:room:<room>:<anchor>`; `floorAssetKey` → background placement; stations → lobby
  objects; add an authored world-exit portal anchor. `manor_lobby_room` stays aliased to
  `manor_main_room`.
- Dungeon → near copy; anchors get `point` (spawn/portal anchors their role); add an inset floor;
  room `revision = dungeon.revision`; prefabs/rewards/bosses/entrances → library.
- Greenhouse → one room `greenhouse_main_room`; surfaces → floors/walls; exit → world portal +
  click area; water storage → `water_tank`; pot/tank templates → prefabs with footprint + click
  area; stage art → planters module; overlays → placements.
- Salon → author a 1000² space from `shared/salon.ts` constants: `salon_chair` + world portal.

Old exports (`MANOR_MAIN_ROOM`, `DUNGEON_CATALOG`, `GREENHOUSE_STUDIO_CATALOG`, `SALON_MAIN_ROOM`)
become read-only views over the unified catalog until the renderer's greenhouse and manor phases (see Status).

DB: no change while ids are preserved (`manor_decoration_placements`, `dungeon_instance_state`,
`dungeon_resource_states`, `greenhouse_plant_anchors`, `players.location_space_id` /
`last_portal_id`). Constraints to respect: `salon_presence` 0..1000; check whether
`player_manor_presence` (24..976) is still used. U3 relaxes the drop tables' `space_id IN
('manor_foyer','manor_main_room')` checks (migrations 0843, 0846) so drops work in every Manor room.

## Shared runtime helpers

`packages/shared/src/interior/interiorRoomRuntime.ts` (pure): `interiorNavigation(room,
extraColliders)`, `resolveMoveTarget(nav, from, to)` (Manor's OUT_OF_BOUNDS / BLOCKED_TARGET /
NO_ROUTE classification), `spawnPoint(room, occupied)` (Manor's offset search),
`interactionInRange(room, target, pos)`, `spacePortals(space)`. Runtimes keep their own sessions
and business rules. The portal registry's hand-built Manor/Salon/Greenhouse branches become one
generic builder from `space.portals` (the data-driven dungeon builder is the template); legacy
foyer routes keep resolving.

## Phases

| Phase | Scope | Renderer phase | Status |
|---|---|---|---|
| U0 | Schema, `interiorRoomRuntime`, four transforms, golden id tests, walkability-equivalence tests. Shared only, no runtime change. | before P3 | done |
| U1 | Dungeon spaces + library committed; `DUNGEON_CATALOG` becomes a view; dungeon runtime + portal registry read unified data. | with P2 | done |
| U2 | Greenhouse on the schema; planter/water_tank objects; authored exit (fixes 830,830); runtime uses helpers. | with P3 | done |
| U3 | Salon + Manor on the schema; stations as objects; authored Manor exit; generic portal builder; drop-table migration. | before P4 | done |
| U4 | InteriorStudio: DungeonStudio shell + Manor canvas tools + greenhouse panels; one publish route; old Manor/Greenhouse Studio tabs removed. | after U3 | done |
| U5 | Scaffolder emits the schema (`pnpm interior:scaffold --kind`); dead legacy loaders, path constants and Studio CSS deleted; runtime views kept (see below). | after P4 | done |

Risks: id drift in transforms (golden tests fail on any id change); dungeon floor inset semantics
(equivalence test); Manor portal ids must stay room+anchor derived; merge conflicts with in-flight
dungeon work (land U1 quickly, keep views until U5); U4 scope creep (no Manor triggers).

## Status (U0-U5 done)

Everything above is implemented: one schema and data directory, one Studio (InteriorStudio), one
scaffolder (`pnpm interior:scaffold --kind dungeon|manor`, `dungeon:scaffold` kept as an alias;
spec reference in `docs/appearance-studio.md`), one navigation/move helper set.

Remaining follow-up: the runtime read-only views (`DUNGEON_CATALOG`, the Manor template catalog,
`GREENHOUSE_STUDIO_CATALOG`, `SALON_MAIN_ROOM`, `interior/*View.ts`) are still consumed by the server
and client. They are removed, and those callers read `InteriorSpace` directly, in the renderer's
greenhouse and manor phases (see `INTERIOR_MAP_RENDERER.md`). U5 deliberately deleted only code with
no remaining reference.

Decisions made while implementing:

- Dungeon rooms keep their one inset rectangle floor; Manor floors are the walkable standard.
- Interior scaffolder: dungeon specs are compiled by the existing dungeon spec compiler and mapped to
  a space in memory (only the new space, the bumped `_library.json` and `index.ts` are written, all
  or nothing, via the Studio's publish plan); manor specs are built directly. Both are validated
  with the catalog rules (dungeon and Manor view parse) before anything is written, and existing ids
  are refused.
- Manor scaffold: doors create paired portal anchors, reciprocal portal records and click areas
  (runtime id `manor:<space>:room:<room>:<anchor>`); stations default to the lobby positions in the
  entrance room; the world exit defaults to the lobby exit door and arrival from the world is the
  entrance room's spawn.
- The Walk Test treats collision-enabled decoration footprints as extra colliders (same rule as
  player placement), through `interiorNavigation(room, extraColliders)`.
- Dungeon catalog resource fields `minYield`, `maxYield`, `respawnSeconds` and `resetOnRun` remain
  editable in the Studio but are ignored in-game: dungeon mines follow the overworld harvest rules
  and do not regenerate within a run.
