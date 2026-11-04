import path from "node:path";
import { fileURLToPath } from "node:url";

import { INTERIOR_DATA_RELATIVE_DIR, findIndoorNavigationRoute, isIndoorNavigationPointWalkable } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { readDungeonInteriorFiles } from "./dungeonInteriorStore.js";
import { addPolygonShape } from "./interiorAuthoring.js";
import { interiorEditingView, interiorFromEditingView } from "./interiorStudioModel.js";
import { doorClickMessage, interiorWalkTestRoom, type WalkTestRoom } from "./InteriorWalkTestCanvas.js";

const committed = path.join(fileURLToPath(new URL("../../..", import.meta.url)), INTERIOR_DATA_RELATIVE_DIR);

describe("interior Walk Test room model", () => {
  it("walks on the drawn floors, not the room bounds, and keeps typed anchors", async () => {
    const base = structuredClone((await readDungeonInteriorFiles(committed)).interior);
    const view = structuredClone(interiorEditingView(base));
    const sources = { base, seeds: {} };
    const stored = base.spaces.find((space) => space.kind === "dungeon")!;
    const definition = view.dungeons.find((dungeon) => dungeon.id === stored.id)!;
    const room = definition.rooms.find((candidate) => !candidate.retired && candidate.active)!;

    // The first drawn floor replaces the dungeon's automatic inset floor.
    const drawn = addPolygonShape(view, sources, stored.id, room.id, "floor", [{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 300 }, { x: 100, y: 300 }]);
    expect(drawn.ok).toBe(true);

    const exportedSpace = interiorFromEditingView(base, {}, view).spaces.find((space) => space.id === stored.id)!;
    const exportedRoom = exportedSpace.rooms.find((candidate) => candidate.id === room.id)!;
    const walk = interiorWalkTestRoom(exportedSpace, exportedRoom);

    expect(walk.navigation.walkableSurfaces).toContainEqual([{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 300 }, { x: 100, y: 300 }]);
    // Inside the drawn floor is reachable; a point outside every floor is not.
    expect(findIndoorNavigationRoute(walk.navigation, { x: 150, y: 150 }, { x: 250, y: 250 })).not.toBeNull();
    const outside = { x: exportedRoom.width - 40, y: exportedRoom.height - 40 };
    expect(findIndoorNavigationRoute(walk.navigation, { x: 150, y: 150 }, outside)).toBeNull();
    // Roles carry over as anchor kinds.
    expect(walk.anchors.map((anchor) => anchor.kind)).toEqual(exportedRoom.anchors.map((anchor) => anchor.role));
  });

  it("opens authored message text from a click area without an exit anchor", () => {
    const square = [{ x: 0, y: 1000 }, { x: 100, y: 1000 }, { x: 100, y: 1100 }, { x: 0, y: 1100 }];
    const room = {
      id: "room",
      anchors: [{ id: "door", retired: false, x: 50, y: 1080, kind: "message", message: "  Upstairs under construction! -Wren  " }],
      hotspots: [{ anchorId: "door", interactionLabel: "Door interaction", polygon: square }]
    } as unknown as WalkTestRoom;
    expect(doorClickMessage(room, { x: 50, y: 1080 })).toEqual({ title: "Door interaction", text: "Upstairs under construction! -Wren" });
    expect(doorClickMessage(room, { x: 300, y: 300 })).toBe(null);
  });

  it("blocks on collision-enabled decoration footprints only", async () => {
    const { interior } = await readDungeonInteriorFiles(committed);
    const space = structuredClone(interior.spaces.find((entry) => entry.kind === "manor")!);
    const room = space.rooms.find((entry) => entry.id === space.defaultRoomId)!;
    const floor = room.floors.find((entry) => !entry.retired)!;
    const xs = floor.polygon.map((point) => point.x);
    const ys = floor.polygon.map((point) => point.y);
    const center = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
    const base = space.modules!.decoration!.definitions[0]!;
    const crate = (id: string, collision: boolean, retired = false) => ({
      ...structuredClone(base), id, roomId: room.id, surfaceId: floor.id, collision, retired, layer: "in_front" as const,
      transform: { ...base.transform, x: center.x, y: center.y, width: 100, height: 100, scaleX: 1, scaleY: 1, rotationDeg: 0, anchorX: 0.5, anchorY: 0.5 },
      footprint: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]
    });
    const walkFrom = { x: center.x - 200, y: center.y };
    const walkTo = { x: center.x + 200, y: center.y };
    const withDecorations = (definitions: ReturnType<typeof crate>[]) => {
      space.modules!.decoration!.definitions = definitions;
      return interiorWalkTestRoom(space, room).navigation;
    };
    const blocked = withDecorations([crate("crate_solid", true)]);
    expect(blocked.colliders.map((collider) => collider.id)).toContain("decoration:crate_solid");
    expect(isIndoorNavigationPointWalkable(blocked, center)).toBe(false);
    const route = findIndoorNavigationRoute(blocked, walkFrom, walkTo);
    expect(route === null || route.length > 1).toBe(true);
    for (const ignored of [crate("crate_soft", false), crate("crate_retired", true, true)]) {
      const navigation = withDecorations([ignored]);
      expect(navigation.colliders.some((collider) => collider.id.startsWith("decoration:"))).toBe(false);
      expect(isIndoorNavigationPointWalkable(navigation, center)).toBe(true);
    }
  });
});
