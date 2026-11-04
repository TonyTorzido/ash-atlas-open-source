import { describe, expect, it } from "vitest";

import { isIndoorNavigationPointWalkable, type IndoorPoint } from "../indoor.js";
import type { InteriorRoom } from "./interiorCatalog.js";
import {
  interactionInRange,
  interiorNavigation,
  resolveMoveTarget,
  spacePortals,
  spawnPoint
} from "./interiorRoomRuntime.js";
import { fromManorTemplateCatalog, salonSpace } from "./transforms.js";

const manorSpace = fromManorTemplateCatalog().spaces[0]!;
const lobby = manorSpace.rooms.find((room) => room.id === manorSpace.defaultRoomId)!;

/** Manor's `moveTo` classification (apps/server manor.ts) as the parity reference. */
function legacyManorClassification(
  navigation: ReturnType<typeof interiorNavigation>,
  from: IndoorPoint,
  to: IndoorPoint
): string {
  const hasFloor = Boolean(navigation.walkableSurfaces && navigation.walkableSurfaces.length > 0);
  const min = hasFloor ? 0 : navigation.playerRadius;
  if (to.x < min || to.y < min || to.x > navigation.roomWidth - min || to.y > navigation.roomHeight - min) return "OUT_OF_BOUNDS";
  if (Math.hypot(to.x - from.x, to.y - from.y) > 1500) return "INVALID_MOVE";
  return "";
}

describe("resolveMoveTarget", () => {
  const navigation = interiorNavigation(lobby);
  const from = { x: 627, y: 1100 };

  it("accepts a walkable target with a route", () => {
    const result = resolveMoveTarget(navigation, from, { x: 600, y: 600 });
    expect(result).toEqual({ ok: true, target: { x: 600, y: 600 }, route: [{ x: 600, y: 600 }] });
  });

  it("classifies out-of-bounds, off-floor, too-far, non-finite targets like Manor", () => {
    expect(legacyManorClassification(navigation, from, { x: -1, y: 600 })).toBe("OUT_OF_BOUNDS");
    expect(resolveMoveTarget(navigation, from, { x: -1, y: 600 })).toMatchObject({ ok: false, code: "OUT_OF_BOUNDS" });
    // Inside the room rectangle but above the authored floor polygon.
    expect(resolveMoveTarget(navigation, from, { x: 600, y: 100 })).toMatchObject({ ok: false, code: "OUT_OF_BOUNDS" });
    expect(resolveMoveTarget(navigation, { x: 0, y: 1250 }, { x: 1180, y: 200 })).toMatchObject({ ok: false, code: "TOO_FAR" });
    expect(legacyManorClassification(navigation, { x: 0, y: 1250 }, { x: 1180, y: 200 })).toBe("INVALID_MOVE");
    expect(resolveMoveTarget(navigation, from, { x: Number.NaN, y: 600 })).toMatchObject({ ok: false, code: "INVALID_MOVE" });
  });

  it("classifies blocked targets and unreachable targets", () => {
    const blocked = interiorNavigation(lobby, [{ id: "pot", minX: 580, maxX: 680, minY: 560, maxY: 660 }]);
    expect(resolveMoveTarget(blocked, from, { x: 630, y: 610 })).toMatchObject({ ok: false, code: "BLOCKED_TARGET" });
    const routed = resolveMoveTarget(blocked, { x: 627, y: 800 }, { x: 627, y: 450 });
    expect(routed.ok && routed.route.length).toBeGreaterThan(1);

    const islands: InteriorRoom = {
      ...lobby,
      floors: [
        { id: "left", retired: false, polygon: [{ x: 100, y: 300 }, { x: 400, y: 300 }, { x: 400, y: 900 }, { x: 100, y: 900 }] },
        { id: "right", retired: false, polygon: [{ x: 700, y: 300 }, { x: 1000, y: 300 }, { x: 1000, y: 900 }, { x: 700, y: 900 }] }
      ]
    };
    expect(resolveMoveTarget(interiorNavigation(islands), { x: 200, y: 600 }, { x: 800, y: 600 }))
      .toMatchObject({ ok: false, code: "NO_ROUTE" });
  });
});

describe("spawnPoint", () => {
  /** Manor's `nextSpawn` offset search (apps/server manor.ts) as the parity reference. */
  function legacyNextSpawn(room: InteriorRoom, occupied: readonly IndoorPoint[]): IndoorPoint {
    const navigation = interiorNavigation(room);
    const spawn = room.anchors.find((anchor) => anchor.id === room.spawnAnchorId)!;
    const taken = new Set(occupied.map((point) => `${point.x}:${point.y}`));
    const offsets = [
      [0, 0], [-70, 0], [70, 0], [0, -70], [-70, -70], [70, -70],
      [-140, 0], [140, 0], [-140, -70], [140, -70]
    ] as const;
    const found = offsets.map(([x, y]) => ({ x: spawn.x + x, y: spawn.y + y }))
      .find((candidate) => !taken.has(`${candidate.x}:${candidate.y}`) && isIndoorNavigationPointWalkable(navigation, candidate));
    if (found) return found;
    const fallback = { x: spawn.x, y: spawn.y - 140 };
    return isIndoorNavigationPointWalkable(navigation, fallback) ? fallback : { x: spawn.x, y: spawn.y };
  }

  it("uses the spawn anchor first, then the offset ring around it", () => {
    const spawn = lobby.anchors.find((anchor) => anchor.id === lobby.spawnAnchorId)!;
    expect(spawnPoint(lobby)).toEqual({ x: spawn.x, y: spawn.y });
    const first = spawnPoint(lobby);
    const second = spawnPoint(lobby, [first]);
    expect(second).toEqual({ x: spawn.x - 70, y: spawn.y });
    const taken: IndoorPoint[] = [];
    for (let index = 0; index < 12; index += 1) {
      const next = spawnPoint(lobby, taken);
      expect(next).toEqual(legacyNextSpawn(lobby, taken));
      taken.push(next);
    }
  });

  it("skips offsets that are not walkable and honours an explicit navigation", () => {
    const spawn = lobby.anchors.find((anchor) => anchor.id === lobby.spawnAnchorId)!;
    const navigation = interiorNavigation(lobby, [{ id: "rug", minX: spawn.x - 60, maxX: spawn.x + 60, minY: spawn.y - 60, maxY: spawn.y + 60 }]);
    const point = spawnPoint(lobby, [], navigation);
    expect(isIndoorNavigationPointWalkable(navigation, point)).toBe(true);
    expect(point).not.toEqual({ x: spawn.x, y: spawn.y });
  });
});

describe("interactionInRange and spacePortals", () => {
  const salon = salonSpace();
  const salonRoom = salon.rooms[0]!;

  it("uses the object's radius around its anchor, and the door radius for bare anchors", () => {
    expect(interactionInRange(salonRoom, { objectId: "salon_chair" }, { x: 500, y: 255 })).toBe(true);
    expect(interactionInRange(salonRoom, { objectId: "salon_chair" }, { x: 500, y: 300 })).toBe(false);
    expect(interactionInRange(salonRoom, { objectId: "missing" }, { x: 500, y: 170 })).toBe(false);
    expect(interactionInRange(salonRoom, { anchorId: "world_exit" }, { x: 830, y: 830 + 95 })).toBe(true);
    expect(interactionInRange(salonRoom, { anchorId: "world_exit" }, { x: 830, y: 830 + 96 })).toBe(false);
    expect(interactionInRange(salonRoom, { anchorId: "world_exit" }, { x: 830, y: 830 + 200 }, 250)).toBe(true);
  });

  it("lists only active portals", () => {
    expect(spacePortals(salon).map((portal) => portal.id)).toEqual(["salon_main_room-world_exit"]);
    const retired = { portals: [{ ...salon.portals[0]!, retired: true }] };
    expect(spacePortals(retired)).toEqual([]);
    const portals = spacePortals(manorSpace);
    expect(portals.length).toBe(manorSpace.portals.filter((portal) => !portal.retired).length);
  });
});
