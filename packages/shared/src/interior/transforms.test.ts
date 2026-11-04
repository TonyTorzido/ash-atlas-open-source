import { describe, expect, it } from "vitest";

import { DUNGEON_CATALOG, dungeonCatalogValidationIssues, type DungeonCatalog } from "../dungeonCatalog.js";
import { cisternWarrensRoomNavigation } from "../dungeon.js";
import { GREENHOUSE_INTERIOR_ROOM, GREENHOUSE_STUDIO_CATALOG, parseGreenhouseStudioCatalog } from "../greenhouseStudio.js";
import {
  findIndoorNavigationRoute,
  isIndoorNavigationPointInsideWalkableSurface,
  isIndoorNavigationPointWalkable,
  type IndoorPoint,
  type IndoorRoomNavigation
} from "../indoor.js";
import { manorAuthoredPortalId, manorAuthoredSpaceId } from "../manor.js";
import {
  DEFAULT_MANOR_TEMPLATE_CATALOG,
  manorCatalogValidationIssues,
  manorTemplateRoomNavigation
} from "../manorTemplateCatalog.js";
import { SALON_MAIN_ROOM } from "../salon.js";
import { dungeonCatalogFromInterior } from "./dungeonView.js";
import { greenhouseStudioInputFromInterior } from "./greenhouseView.js";
import {
  interiorCatalogValidationIssues,
  interiorIdPreservationIssues,
  interiorRevisionIdentityIssues,
  validateInteriorCatalog,
  type InteriorCatalog,
  type InteriorRoom,
  type InteriorSpace
} from "./interiorCatalog.js";
import { interiorNavigation } from "./interiorRoomRuntime.js";
import {
  fromDungeonCatalog,
  fromGreenhouseStudioCatalog,
  fromManorTemplateCatalog,
  interiorCatalogFromLegacy,
  manorPortalRecordId,
  manorRuntimePortalId,
  mergeInteriorLibrary,
  salonSpace
} from "./transforms.js";

const ids = (values: readonly { id: string }[]) => values.map((value) => value.id).sort();
const missingFrom = (source: readonly string[], target: readonly string[]) => {
  const present = new Set(target);
  return source.filter((value) => !present.has(value));
};
function room(space: InteriorSpace, roomId: string): InteriorRoom {
  const found = space.rooms.find((candidate) => candidate.id === roomId);
  if (!found) throw new Error(`missing room ${roomId}`);
  return found;
}
const clone = <T>(value: T): T => structuredClone(value);

describe("golden id preservation", () => {
  it("keeps every Manor id", () => {
    const { spaces } = fromManorTemplateCatalog();
    expect(spaces.map((space) => space.id)).toEqual(DEFAULT_MANOR_TEMPLATE_CATALOG.templates.map((template) => template.id));
    for (const template of DEFAULT_MANOR_TEMPLATE_CATALOG.templates) {
      const space = spaces.find((candidate) => candidate.id === template.id)!;
      expect(space.revision).toBe(template.revision);
      expect(space.publishedRevisionId).toBe(template.publishedRevisionId);
      expect(space.defaultRoomId).toBe(template.defaultRoomId);
      expect(ids(space.rooms)).toEqual([...template.rooms.map((legacy) => legacy.id)].sort());
      for (const legacy of template.rooms) {
        const converted = room(space, legacy.id);
        expect(converted.revision).toBe(legacy.revision);
        expect(converted.spawnAnchorId).toBe(legacy.spawnAnchorId);
        expect(missingFrom(legacy.anchors.map((anchor) => anchor.id), converted.anchors.map((anchor) => anchor.id))).toEqual([]);
        expect(missingFrom(legacy.colliders.map((collider) => collider.id), converted.colliders.map((collider) => collider.id))).toEqual([]);
        expect(ids(converted.floors)).toEqual(legacy.placementSurfaces.filter((surface) => surface.kind === "floor").map((surface) => surface.id).sort());
        expect(ids(converted.walls)).toEqual(legacy.placementSurfaces.filter((surface) => surface.kind !== "floor").map((surface) => surface.id).sort());
        expect(missingFrom(legacy.portalHotspots.map((hotspot) => hotspot.id), converted.clickAreas.map((area) => area.id))).toEqual([]);
        for (const hotspot of legacy.portalHotspots) {
          const area = converted.clickAreas.find((candidate) => candidate.id === hotspot.id)!;
          expect(area.target).toEqual({ anchorId: hotspot.anchorId });
          expect(area.retired).toBe(hotspot.retired);
        }
        for (const anchor of legacy.anchors) {
          const convertedAnchor = converted.anchors.find((candidate) => candidate.id === anchor.id)!;
          expect(convertedAnchor.role).toBe(anchor.type);
          expect(convertedAnchor.retired).toBe(anchor.retired);
          if (anchor.type !== "portal" || !anchor.destinationRoomId) continue;
          const portal = space.portals.find((candidate) => candidate.id === manorPortalRecordId(legacy.id, anchor.id))!;
          expect(portal.enabled).toBe(anchor.locked !== true);
          expect(portal.destination).toEqual({ kind: "room", roomId: anchor.destinationRoomId, anchorId: anchor.destinationAnchorId });
          expect(manorRuntimePortalId("manor-1", portal)).toBe(manorAuthoredPortalId("manor-1", legacy.id, anchor.id));
        }
      }
      expect(missingFrom(
        template.decorations.map((decoration) => decoration.id),
        space.modules!.decoration!.definitions.map((decoration) => decoration.id)
      )).toEqual([]);
    }
  });

  it("keeps the manor_lobby_room alias and adds the authored world exit and stations", () => {
    const space = fromManorTemplateCatalog().spaces.find((candidate) => candidate.id === "manor_lobby");
    const lobby = room(space!, space!.defaultRoomId);
    expect(lobby.aliases).toEqual(["manor_main_room"]);
    expect(manorAuthoredSpaceId(lobby.id)).toBe("manor_main_room");
    const exit = space!.portals.find((portal) => portal.destination.kind === "world")!;
    expect(exit.source).toEqual({ kind: "room", roomId: lobby.id, anchorId: "world_exit" });
    expect(lobby.anchors.find((anchor) => anchor.id === "world_exit")?.role).toBe("portal");
    expect(lobby.clickAreas.some((area) => "anchorId" in area.target && area.target.anchorId === "world_exit")).toBe(true);
    expect(lobby.objects.filter((object) => object.type === "station").map((object) => object.stationKind).sort())
      .toEqual(["breeder", "jewel", "smith"]);
    // Locked upstairs rooms stay disabled portals.
    expect(space!.portals.find((portal) => portal.id === manorPortalRecordId("upstairs_hallway", "room_2"))?.enabled).toBe(false);
  });

  it("keeps every dungeon id and round-trips to the identical dungeon catalog", () => {
    const { spaces, library } = fromDungeonCatalog();
    expect(spaces.map((space) => space.id)).toEqual(DUNGEON_CATALOG.dungeons.map((dungeon) => dungeon.id));
    for (const dungeon of DUNGEON_CATALOG.dungeons) {
      const space = spaces.find((candidate) => candidate.id === dungeon.id)!;
      const modules = space.modules!;
      expect(ids(space.portals)).toEqual(ids(dungeon.portals));
      expect(ids(modules.encounters!)).toEqual(ids(dungeon.encounters));
      expect(ids(modules.triggers!)).toEqual(ids(dungeon.triggers));
      expect(ids(space.rooms)).toEqual(ids(dungeon.rooms));
      for (const legacy of dungeon.rooms) {
        const converted = room(space, legacy.id);
        expect(converted.revision).toBe(dungeon.revision);
        expect(ids(converted.anchors)).toEqual(ids(legacy.anchors));
        expect(ids(converted.colliders)).toEqual(ids(legacy.colliders));
        expect(ids(converted.zones)).toEqual(ids(legacy.zones));
        expect(ids(converted.objects)).toEqual(ids(legacy.objects));
        expect(ids(converted.mobs)).toEqual(ids(legacy.mobs));
        expect(ids(converted.resourceNodes ?? [])).toEqual(ids(legacy.resourceNodes ?? []));
        expect(ids(converted.resourceSpawnZones ?? [])).toEqual(ids(legacy.resourceSpawnZones ?? []));
        expect(ids(Object.values(converted.layers).flat())).toEqual(ids(Object.values(legacy.layers).flat()));
        expect(converted.anchors.find((anchor) => anchor.id === legacy.spawnAnchorId)?.role).toBe("spawn");
      }
    }
    expect(ids(library.prefabs)).toEqual(ids(DUNGEON_CATALOG.prefabs));
    expect(ids(library.rewardTables)).toEqual(ids(DUNGEON_CATALOG.rewardTables));
    expect(ids(library.bossTemplates)).toEqual(ids(DUNGEON_CATALOG.bossTemplates));
    expect(ids(library.entrances)).toEqual(ids(DUNGEON_CATALOG.entrances));
    const roundTrip = dungeonCatalogFromInterior({
      library: mergeInteriorLibrary([library], DUNGEON_CATALOG.catalogRevision),
      spaces
    });
    expect(roundTrip).toEqual(DUNGEON_CATALOG);
  });

  it("keeps every Greenhouse id", () => {
    const { spaces, library } = fromGreenhouseStudioCatalog();
    const space = spaces[0]!;
    const converted = room(space, GREENHOUSE_STUDIO_CATALOG.roomId);
    expect(space.rooms).toHaveLength(1);
    const surfaces = [...converted.floors, ...converted.walls].map((surface) => surface.id);
    expect(surfaces.sort()).toEqual(GREENHOUSE_STUDIO_CATALOG.geometry.surfaces.map((surface) => surface.surfaceId).sort());
    expect(ids(converted.colliders)).toEqual(GREENHOUSE_STUDIO_CATALOG.geometry.colliders.map((collider) => collider.colliderId).sort());
    const anchorIds = converted.anchors.map((anchor) => anchor.id);
    expect(missingFrom(GREENHOUSE_STUDIO_CATALOG.anchors.map((anchor) => anchor.anchorId), anchorIds)).toEqual([]);
    expect(anchorIds).toContain(GREENHOUSE_STUDIO_CATALOG.waterStorage.anchorId);
    expect(anchorIds).toContain(GREENHOUSE_STUDIO_CATALOG.geometry.exit.anchorId);
    const placementIds = Object.values(converted.layers).flat().map((placement) => placement.id);
    expect(placementIds).toContain(GREENHOUSE_STUDIO_CATALOG.waterStorageArt.overlayId);
    expect(missingFrom(GREENHOUSE_STUDIO_CATALOG.overlays.map((overlay) => overlay.overlayId), placementIds)).toEqual([]);
    expect(space.modules!.planters!.stageArt.map((art) => `${art.cropId}:${art.artId}`).sort())
      .toEqual(GREENHOUSE_STUDIO_CATALOG.geometry.stageArt.map((art) => `${art.cropId}:${art.artId}`).sort());
    expect(space.modules!.planters!.capacity).toBe(GREENHOUSE_STUDIO_CATALOG.planterCapacity);
    expect(converted.objects.map((object) => object.type).sort()).toEqual([
      ...GREENHOUSE_STUDIO_CATALOG.anchors.map(() => "planter"), "water_tank"
    ].sort());
    expect(converted.clickAreas.map((area) => area.target)).toEqual(expect.arrayContaining([
      { objectId: `greenhouse-water-tank:${GREENHOUSE_STUDIO_CATALOG.roomId}` }
    ]));
    // The exit is authored where the Studio put it, not at the 830,830 constant.
    const exit = converted.anchors.find((anchor) => anchor.id === GREENHOUSE_STUDIO_CATALOG.geometry.exit.anchorId)!;
    expect({ x: exit.x, y: exit.y }).toEqual({ x: GREENHOUSE_STUDIO_CATALOG.geometry.exit.x, y: GREENHOUSE_STUDIO_CATALOG.geometry.exit.y });
    expect(space.portals).toHaveLength(1);
    expect(space.portals[0]!.destination).toEqual({ kind: "world" });
    expect(ids(library.prefabs)).toContain("greenhouse_pot");
  });

  it("authors the Salon from the shared constants", () => {
    const space = salonSpace();
    const converted = room(space, SALON_MAIN_ROOM.spaceId);
    expect(ids(converted.colliders)).toEqual(SALON_MAIN_ROOM.colliders.map((collider) => collider.id));
    expect(converted.objects.map((object) => object.type)).toEqual(["salon_chair"]);
    expect(space.portals[0]!.destination).toEqual({ kind: "world" });
  });
});

const GRID_STEP = 20;

function samplePoints(width: number, height: number, extra: readonly IndoorPoint[]): IndoorPoint[] {
  const points: IndoorPoint[] = [...extra];
  for (let x = -20; x <= width + 20; x += GRID_STEP) {
    for (let y = -20; y <= height + 20; y += GRID_STEP) points.push({ x, y });
  }
  // Boundary-exact and just-inside/outside values around the player radius inset.
  for (const value of [23.999, 24, 24.001, width - 24.001, width - 24, width - 23.999, 0, width]) {
    points.push({ x: value, y: 500 }, { x: 500, y: value }, { x: value, y: value });
  }
  return points;
}

function assertSameNavigation(
  legacy: IndoorRoomNavigation,
  converted: IndoorRoomNavigation,
  label: string
): void {
  expect(converted.roomWidth, label).toBe(legacy.roomWidth);
  expect(converted.roomHeight, label).toBe(legacy.roomHeight);
  expect(converted.playerRadius, label).toBe(legacy.playerRadius);
  const vertices = (legacy.walkableSurfaces ?? []).flat();
  const points = samplePoints(legacy.roomWidth, legacy.roomHeight, vertices);
  const walkable: IndoorPoint[] = [];
  let walkableCount = 0;
  for (const point of points) {
    const expected = isIndoorNavigationPointWalkable(legacy, point);
    if (isIndoorNavigationPointWalkable(converted, point) !== expected) {
      throw new Error(`${label}: walkability differs at ${point.x},${point.y} (legacy ${expected})`);
    }
    if (legacy.walkableSurfaces?.length &&
      isIndoorNavigationPointInsideWalkableSurface(converted, point) !== isIndoorNavigationPointInsideWalkableSurface(legacy, point)) {
      throw new Error(`${label}: floor containment differs at ${point.x},${point.y}`);
    }
    if (expected) {
      walkableCount += 1;
      if (walkableCount % 37 === 0) walkable.push(point);
    }
  }
  expect(walkableCount, `${label} has walkable samples`).toBeGreaterThan(0);
  // Routes: every 3rd pair of a thinned walkable sample.
  for (let index = 0; index + 1 < walkable.length; index += 3) {
    expect(findIndoorNavigationRoute(converted, walkable[index]!, walkable[index + 1]!), label)
      .toEqual(findIndoorNavigationRoute(legacy, walkable[index]!, walkable[index + 1]!));
  }
}

describe("walkability equivalence", () => {
  it("matches manorTemplateRoomNavigation for every Manor room, retired or not", () => {
    const { spaces } = fromManorTemplateCatalog();
    for (const template of DEFAULT_MANOR_TEMPLATE_CATALOG.templates) {
      const space = spaces.find((candidate) => candidate.id === template.id)!;
      for (const legacy of template.rooms) {
        assertSameNavigation(
          manorTemplateRoomNavigation(legacy),
          interiorNavigation(room(space, legacy.id)),
          `manor ${legacy.id}`
        );
      }
    }
  });

  it("matches the server dungeon navigation projection for every dungeon room", () => {
    const { spaces } = fromDungeonCatalog();
    for (const dungeon of DUNGEON_CATALOG.dungeons) {
      const space = spaces.find((candidate) => candidate.id === dungeon.id)!;
      for (const legacy of dungeon.rooms) {
        assertSameNavigation(
          cisternWarrensRoomNavigation(legacy.id, dungeon),
          interiorNavigation(room(space, legacy.id)),
          `dungeon ${dungeon.id}/${legacy.id}`
        );
      }
    }
  });

  it("matches dungeon colliders of every shape, including retired ones", () => {
    const catalog: DungeonCatalog = clone(DUNGEON_CATALOG);
    const dungeon = catalog.dungeons.find((candidate) => candidate.id === "cistern_warrens")!;
    const target = dungeon.rooms.find((candidate) => candidate.id === "hatch_landing")!;
    target.colliders = [
      { id: "crate", retired: false, kind: "rectangle", x: 300, y: 300, width: 120, height: 80 },
      { id: "pillar", retired: false, kind: "polygon", points: [{ x: 600, y: 300 }, { x: 700, y: 340 }, { x: 640, y: 460 }] },
      { id: "gone", retired: true, kind: "rectangle", x: 100, y: 600, width: 300, height: 200 }
    ];
    const { spaces } = fromDungeonCatalog(catalog);
    const legacy = cisternWarrensRoomNavigation("hatch_landing", dungeon);
    const converted = interiorNavigation(room(spaces.find((space) => space.id === "cistern_warrens")!, "hatch_landing"));
    expect(converted.colliders).toHaveLength(2);
    assertSameNavigation(legacy, converted, "dungeon with colliders");
  });

  it("matches the Greenhouse runtime navigation", () => {
    const catalog = GREENHOUSE_STUDIO_CATALOG;
    // Same construction as apps/server greenhouseRuntime.greenhouseNavigation().
    const legacy = manorTemplateRoomNavigation({
      width: catalog.roomWidth,
      height: catalog.roomHeight,
      colliders: catalog.geometry.colliders.map((collider) => ({ id: collider.colliderId, retired: false, kind: "polygon" as const, points: [...collider.points] })),
      placementSurfaces: catalog.geometry.surfaces.map((surface) => surface.kind === "floor"
        ? { id: surface.surfaceId, retired: false, kind: "floor" as const, polygon: [...surface.points] }
        : { id: surface.surfaceId, retired: false, kind: surface.kind, roomPolygon: [...surface.points], imagePolygon: [{ u: 0, v: 0 }, { u: 1, v: 0 }, { u: 1, v: 1 }], transform: { offsetU: 0, offsetV: 0, scaleU: 1, scaleV: 1, rotationDeg: 0 } })
    });
    const space = fromGreenhouseStudioCatalog().spaces[0]!;
    assertSameNavigation(legacy, interiorNavigation(room(space, catalog.roomId)), "greenhouse");
  });

  it("matches SALON_MAIN_ROOM", () => {
    const space = salonSpace();
    assertSameNavigation(SALON_MAIN_ROOM, interiorNavigation(room(space, SALON_MAIN_ROOM.spaceId)), "salon");
  });
});

describe("validators", () => {
  it("accepts the transformed legacy catalogs and the old validators still accept the old data", () => {
    const catalog = interiorCatalogFromLegacy();
    expect(interiorCatalogValidationIssues(catalog)).toEqual([]);
    expect(validateInteriorCatalog(catalog).spaces.map((space) => space.kind)).toEqual(["manor", "manor", "manor", "dungeon", "dungeon", "dungeon", "dungeon", "dungeon", "dungeon", "dungeon", "dungeon", "dungeon", "dungeon", "dungeon", "dungeon", "greenhouse", "salon"]);
    expect(manorCatalogValidationIssues(DEFAULT_MANOR_TEMPLATE_CATALOG)).toEqual([]);
    expect(dungeonCatalogValidationIssues(DUNGEON_CATALOG)).toEqual([]);
    expect(parseGreenhouseStudioCatalog(GREENHOUSE_STUDIO_CATALOG).roomId).toBe(GREENHOUSE_STUDIO_CATALOG.roomId);
  });

  it("survives a JSON round trip (what the committed data files will be)", () => {
    const catalog = interiorCatalogFromLegacy();
    expect(validateInteriorCatalog(JSON.parse(JSON.stringify(catalog)))).toEqual(catalog);
  });

  const issuesFor = (mutate: (catalog: InteriorCatalog) => void) => {
    const catalog = clone(interiorCatalogFromLegacy());
    mutate(catalog);
    return interiorCatalogValidationIssues(catalog).map((issue) => `${issue.path}: ${issue.message}`).join("\n");
  };
  const manor = (catalog: InteriorCatalog) => catalog.spaces.find((space) => space.kind === "manor")!;

  it("rejects dungeon-only content in non-dungeon spaces", () => {
    expect(issuesFor((catalog) => { manor(catalog).modules!.encounters = []; }))
      .toMatch(/modules\.encounters: is only supported on dungeon spaces/);
    expect(issuesFor((catalog) => {
      const sample = catalog.spaces.find((space) => space.kind === "dungeon")!.rooms.find((candidate) => candidate.mobs.length > 0)!.mobs[0]!;
      manor(catalog).rooms[0]!.mobs.push(clone(sample));
    })).toMatch(/mobs are only supported in dungeon spaces/);
    expect(issuesFor((catalog) => { manor(catalog).portals[0]!.conditions = ["boss_defeated"]; }))
      .toMatch(/conditions and gates are only supported on dungeon portals/);
    expect(issuesFor((catalog) => {
      catalog.spaces.find((space) => space.kind === "salon")!.modules!.decoration = { definitions: [], playerPlacement: { enabled: true } };
    })).toMatch(/decoration: is only supported on manor spaces/);
  });

  it("rejects broken references, walkability and profile rules", () => {
    expect(issuesFor((catalog) => {
      manor(catalog).rooms[0]!.clickAreas.find((area) => "anchorId" in area.target && !area.retired)!.target = { anchorId: "nope" };
    })).toMatch(/must bind to an active interaction anchor/);
    expect(issuesFor((catalog) => { manor(catalog).rooms[0]!.objects[0]!.anchorId = "spawn"; }))
      .toMatch(/objects reference point anchors/);
    expect(issuesFor((catalog) => {
      const lobby = manor(catalog).rooms[0]!;
      lobby.anchors.find((anchor) => anchor.id === lobby.spawnAnchorId)!.x = 5;
    })).toMatch(/spawn must be inside a walkable floor/);
    expect(issuesFor((catalog) => { manor(catalog).spatialProfileId = "dungeon"; }))
      .toMatch(/spaces use the standard_indoor profile/);
    expect(issuesFor((catalog) => {
      manor(catalog).portals.find((portal) => portal.reciprocalPortalId)!.reciprocalPortalId = "missing";
    })).toMatch(/reciprocalPortalId: references a missing portal/);
    expect(issuesFor((catalog) => { catalog.spaces[1]!.rooms[0]!.id = catalog.spaces[0]!.rooms[0]!.id; }))
      .toMatch(/is already used by/);
    expect(issuesFor((catalog) => {
      catalog.spaces.find((space) => space.kind === "dungeon")!.modules!.encounters![0]!.roomId = "nowhere";
    })).toMatch(/dungeonView\./);
  });
});

describe("permanence helpers", () => {
  it("flags dropped ids and unrevised changes, and allows retiring and revised edits", () => {
    const current = interiorCatalogFromLegacy();
    expect(interiorIdPreservationIssues(current, current)).toEqual([]);
    expect(interiorRevisionIdentityIssues(current, current)).toEqual([]);

    const dropped = clone(current);
    const lobby = dropped.spaces.find((space) => space.id === "manor_lobby")!.rooms[0]!;
    lobby.anchors = lobby.anchors.filter((anchor) => anchor.id !== "spawn");
    dropped.spaces.find((space) => space.id === "cistern_warrens")!.portals.pop();
    expect(interiorIdPreservationIssues(current, dropped)).toEqual(expect.arrayContaining([
      expect.stringContaining("anchor in manor_lobby/manor_lobby_room spawn was removed"),
      expect.stringContaining("portal in cistern_warrens")
    ]));

    const retired = clone(current);
    retired.spaces.find((space) => space.id === "manor_lobby")!.rooms[0]!.anchors.find((anchor) => anchor.id === "spawn")!.retired = true;
    expect(interiorIdPreservationIssues(current, retired)).toEqual([]);
    expect(interiorRevisionIdentityIssues(current, retired)).toEqual(expect.arrayContaining([
      "room manor_lobby/manor_lobby_room changed without a new revision",
      "space manor_lobby changed without a new revision"
    ]));
    retired.spaces.find((space) => space.id === "manor_lobby")!.rooms[0]!.revision = "manor_lobby-room-edited-v1";
    retired.spaces.find((space) => space.id === "manor_lobby")!.revision = "manor_lobby-edited-v1";
    expect(interiorRevisionIdentityIssues(current, retired)).toEqual([]);
  });
});

describe("committed interior data", () => {
  it("is the dungeon catalog's single source: valid, and identical to a fresh transform of the view", async () => {
    const { INTERIOR_DATA } = await import("../data/interiors/index.js");
    const committed = INTERIOR_DATA as unknown as InteriorCatalog;
    expect(interiorCatalogValidationIssues(committed)).toEqual([]);
    const fresh = fromDungeonCatalog(DUNGEON_CATALOG);
    expect(committed.spaces.filter((space) => space.kind === "dungeon")).toEqual(fresh.spaces);
    const dungeonPrefabs = committed.library.prefabs.filter((prefab) => prefab.assetKey.startsWith("apps/client/public/assets/dungeons/"));
    expect(dungeonPrefabs).toEqual(fresh.library.prefabs);
    expect(committed.library.catalogRevision).toBe(DUNGEON_CATALOG.catalogRevision);
  });

  it("holds the Greenhouse: GREENHOUSE_STUDIO_CATALOG is its read-only view and a fresh transform of it changes nothing", async () => {
    const { INTERIOR_DATA } = await import("../data/interiors/index.js");
    const committed = INTERIOR_DATA as unknown as InteriorCatalog;
    const fresh = fromGreenhouseStudioCatalog(GREENHOUSE_STUDIO_CATALOG);
    expect(committed.spaces.find((space) => space.kind === "greenhouse")).toEqual(fresh.spaces[0]);
    expect(committed.library.prefabs).toEqual(expect.arrayContaining([...fresh.library.prefabs]));
    expect(GREENHOUSE_INTERIOR_ROOM.id).toBe(GREENHOUSE_STUDIO_CATALOG.roomId);
    // The exit is authored at the Studio position, not the retired 830,830 constant.
    const exit = GREENHOUSE_STUDIO_CATALOG.geometry.exit;
    expect({ x: exit.x, y: exit.y }).toEqual({ x: 627, y: 1158 });
  });

  it("round-trips Greenhouse Studio edits through the interior space (view -> transform -> view)", () => {
    const edited = parseGreenhouseStudioCatalog({
      ...GREENHOUSE_STUDIO_CATALOG,
      catalogRevision: 7,
      waterStorage: { ...GREENHOUSE_STUDIO_CATALOG.waterStorage, x: 900, y: 640 },
      waterStorageArt: { ...GREENHOUSE_STUDIO_CATALOG.waterStorageArt, x: 800, y: 560, scaleX: 1.5, scaleY: 0.5, rotationDeg: 12, zIndex: 3 },
      overlays: [{
        overlayId: "overlay-a", assetPath: "apps/client/src/assets/structures/greenhouse-overlays/overlay-02.png",
        x: 100, y: 120, width: 200, height: 100, rotationDeg: 5, scaleX: 0.75, scaleY: 1.25, zIndex: 4
      }],
      geometry: {
        ...GREENHOUSE_STUDIO_CATALOG.geometry,
        exit: { ...GREENHOUSE_STUDIO_CATALOG.geometry.exit, x: 600, y: 1150, touchArea: { kind: "polygon", points: [{ x: 540, y: 1150 }, { x: 660, y: 1150 }, { x: 660, y: 1250 }, { x: 540, y: 1250 }] } },
        stageArt: GREENHOUSE_STUDIO_CATALOG.geometry.stageArt.map((art, index) => index === 0 ? { ...art, scale: 0.5, offsetY: -12 } : art)
      }
    });
    const transformed = fromGreenhouseStudioCatalog(edited);
    const back = parseGreenhouseStudioCatalog(JSON.parse(JSON.stringify(
      greenhouseStudioInputFromInterior(transformed.spaces[0]!, transformed.library.prefabs)
    )));
    expect(back).toEqual(edited);
  });
});
