import type { DungeonCatalog, DungeonDefinition, DungeonRoomDefinition } from "../dungeonCatalog.js";
import type { InteriorCatalog, InteriorRoom, InteriorSpace } from "./interiorCatalog.js";

/** Dungeon prefabs live under this asset root; other interiors' prefabs are not dungeon prefabs. */
const DUNGEON_ASSET_PREFIX = "apps/client/public/assets/dungeons/";

/**
 * Project the dungeon spaces of an interior catalog back into the legacy
 * `DungeonCatalog` shape. It is the read-only view U1 will hang
 * `DUNGEON_CATALOG` on, and the interior validator uses it to reuse the
 * dungeon encounter/trigger/portal-graph rules instead of copying them.
 */
export function dungeonCatalogFromInterior(catalog: InteriorCatalog): DungeonCatalog {
  const { library } = catalog;
  return {
    schemaVersion: 2,
    catalogRevision: library.catalogRevision,
    spatialProfiles: ["standard_indoor_v1"],
    prefabs: library.prefabs
      .filter((prefab) => prefab.assetKey.startsWith(DUNGEON_ASSET_PREFIX) &&
        prefab.stateAssets.every((state) => state.assetKey.startsWith(DUNGEON_ASSET_PREFIX)))
      .map(({ footprint: _footprint, touchArea: _touchArea, ...prefab }) => prefab as DungeonCatalog["prefabs"][number]),
    entrances: library.entrances,
    rewardTables: library.rewardTables,
    rewardTableIds: library.rewardTableIds,
    bossTemplateIds: library.bossTemplateIds,
    bossTemplates: library.bossTemplates,
    dungeons: catalog.spaces.filter((space) => space.kind === "dungeon").map(dungeonFromSpace)
  };
}

function dungeonFromSpace(space: InteriorSpace): DungeonDefinition {
  const modules = space.modules ?? {};
  return {
    id: space.id,
    revision: space.revision,
    retired: space.retired,
    instancePolicy: space.instancePolicy as DungeonDefinition["instancePolicy"],
    name: space.name,
    description: space.description,
    spatialProfileId: "standard_indoor_v1",
    entrance: modules.entrance!,
    escape: modules.escape!,
    deathRecovery: modules.deathRecovery!,
    reset: modules.reset!,
    environment: space.environment as DungeonDefinition["environment"],
    rooms: space.rooms.map(dungeonRoomFromInterior),
    portals: space.portals as DungeonDefinition["portals"],
    encounters: modules.encounters ?? [],
    triggers: modules.triggers ?? [],
    rewardTableIds: modules.rewardTableIds ?? [],
    bossTemplateIds: modules.bossTemplateIds ?? [],
    ...(modules.access ? { access: modules.access } : {}),
    ...(modules.tier ? { tier: modules.tier } : {}),
    ...(modules.runRolls ? { runRolls: modules.runRolls } : {})
  };
}

function dungeonRoomFromInterior(room: InteriorRoom): DungeonRoomDefinition {
  return {
    id: room.id,
    retired: room.retired,
    name: room.name,
    active: room.active,
    width: room.width,
    height: room.height,
    spatialProfileId: "standard_indoor_v1",
    spawnAnchorId: room.spawnAnchorId,
    camera: room.camera,
    environment: room.environment,
    layers: room.layers,
    anchors: room.anchors.map((anchor) => ({
      id: anchor.id,
      retired: anchor.retired,
      x: anchor.x,
      y: anchor.y,
      ...(anchor.facing !== undefined ? { facing: anchor.facing } : {})
    })),
    colliders: room.colliders,
    zones: room.zones,
    objects: room.objects as DungeonRoomDefinition["objects"],
    mobs: room.mobs,
    ...(room.resourceSpawnZones ? { resourceSpawnZones: room.resourceSpawnZones } : {}),
    ...(room.resourceNodes ? { resourceNodes: room.resourceNodes } : {}),
    floors: room.floors.map((floor) => ({ id: floor.id, retired: floor.retired, polygon: floor.polygon }))
  };
}
