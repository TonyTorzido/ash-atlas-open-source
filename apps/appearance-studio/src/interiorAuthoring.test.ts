import path from "node:path";
import { fileURLToPath } from "node:url";

import { INTERIOR_DATA_RELATIVE_DIR, interiorNavigation, findIndoorNavigationRoute, type InteriorCatalog } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { readDungeonInteriorFiles } from "./dungeonInteriorStore.js";
import {
  addPolygonShape,
  anchorPortalLink,
  anchorRoleOf,
  effectiveRoomAuthoring,
  insetFloorPolygon,
  moveShapeVertex,
  pairPortalAnchors,
  retireAnchor,
  retireShape,
  setAnchorMessage,
  setAnchorRole,
  setShapeVertices,
  translateShape,
  updateClickArea,
  type AuthoringSources,
  type AuthoringView
} from "./interiorAuthoring.js";
import { interiorEditingView, interiorFromEditingView, interiorViewIssues } from "./interiorStudioModel.js";

const committed = path.join(fileURLToPath(new URL("../../..", import.meta.url)), INTERIOR_DATA_RELATIVE_DIR);

async function fixture(): Promise<{ base: InteriorCatalog; view: AuthoringView; sources: AuthoringSources }> {
  const base = structuredClone((await readDungeonInteriorFiles(committed)).interior);
  return { base, view: structuredClone(interiorEditingView(base)), sources: { base, seeds: {} } };
}

const rect = (x: number, y: number, width: number, height: number) => [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
const space = (view: AuthoringView, id: string) => view.dungeons.find((dungeon) => dungeon.id === id)!;
const exported = (base: InteriorCatalog, view: AuthoringView, spaceId: string) => interiorFromEditingView(base, {}, view).spaces.find((candidate) => candidate.id === spaceId)!;

describe("interior room authoring model", () => {
  it("leaves untouched rooms exactly as stored and materializes nothing", async () => {
    const { base, view } = await fixture();
    expect(view.interiorAuthoring).toBeUndefined();
    for (const stored of base.spaces) expect(exported(base, view, stored.id)).toEqual(stored);
  });

  it("replaces an automatic dungeon floor with the first drawn floor, retiring the published one", async () => {
    const { base, view, sources } = await fixture();
    const dungeon = base.spaces.find((candidate) => candidate.kind === "dungeon")!;
    const room = space(view, dungeon.id).rooms.find((candidate) => !candidate.retired && candidate.active)!;
    const before = effectiveRoomAuthoring(view, sources, dungeon.id, room);
    expect(before.autoFloors).toBe(true);
    const drawn = addPolygonShape(view, sources, dungeon.id, room.id, "floor", rect(30, 30, room.width - 60, room.height - 60));
    expect(drawn.ok).toBe(true);
    const after = effectiveRoomAuthoring(view, sources, dungeon.id, room);
    expect(after.autoFloors).toBe(false);
    expect(after.floors.filter((floor) => !floor.retired)).toHaveLength(1);
    expect(after.floors.find((floor) => floor.id === "floor")?.retired).toBe(true);
    const out = exported(base, view, dungeon.id).rooms.find((candidate) => candidate.id === room.id)!;
    expect(out.floors.filter((floor) => !floor.retired).map((floor) => floor.polygon)).toEqual([rect(30, 30, room.width - 60, room.height - 60)]);
    expect(interiorViewIssues(base, {}, view).filter((issue) => issue.path.includes(dungeon.id))).toEqual([]);
  });

  it("keeps a dungeon's automatic floor following the room size", async () => {
    const { base, view, sources } = await fixture();
    const dungeon = base.spaces.find((candidate) => candidate.kind === "dungeon")!;
    const room = space(view, dungeon.id).rooms[0]!;
    room.width += 100;
    room.camera.center.x = room.width / 2;
    expect(effectiveRoomAuthoring(view, sources, dungeon.id, room).floors[0]!.polygon).toEqual(insetFloorPolygon(room.width, room.height));
    expect(exported(base, view, dungeon.id).rooms[0]!.floors[0]!.polygon).toEqual(insetFloorPolygon(room.width, room.height));
  });

  it("draws walls with an image mapping, moves shapes and vertices, and edits vertex lists", async () => {
    const { base, view, sources } = await fixture();
    const manor = base.spaces.find((candidate) => candidate.id === "manor_lobby")!;
    const room = space(view, manor.id).rooms[0]!;
    const wall = addPolygonShape(view, sources, manor.id, room.id, "left_wall", rect(20, 100, 60, 200));
    if (!wall.ok) throw new Error(wall.error);
    expect(effectiveRoomAuthoring(view, sources, manor.id, room).walls.find((value) => value.id === wall.ref.id)).toMatchObject({ kind: "left_wall", retired: false, imagePolygon: [{ u: 0, v: 0 }, { u: 1, v: 0 }, { u: 1, v: 1 }, { u: 0, v: 1 }] });
    expect(translateShape(view, sources, manor.id, room.id, wall.ref, { x: 10, y: 20 })).toBe(true);
    expect(moveShapeVertex(view, sources, manor.id, room.id, wall.ref, 2, { x: 90, y: 330 })).toBe(true);
    const moved = effectiveRoomAuthoring(view, sources, manor.id, room).walls.find((value) => value.id === wall.ref.id)!;
    expect(moved.roomPolygon[0]).toEqual({ x: 30, y: 120 });
    expect(moved.roomPolygon[2]).toEqual({ x: 90, y: 330 });
    // Adding a vertex re-derives the normalized image polygon so it keeps one point per vertex.
    setShapeVertices(view, sources, manor.id, room.id, wall.ref, [...moved.roomPolygon, { x: 30, y: 200 }]);
    const grown = effectiveRoomAuthoring(view, sources, manor.id, room).walls.find((value) => value.id === wall.ref.id)!;
    expect(grown.imagePolygon).toHaveLength(5);
    expect(setShapeVertices(view, sources, manor.id, room.id, wall.ref, moved.roomPolygon.slice(0, 2))).toBe(false);
    expect(exported(base, view, manor.id).rooms[0]!.walls.some((value) => value.id === wall.ref.id)).toBe(true);
    expect(interiorViewIssues(base, {}, view).filter((issue) => issue.path.includes(manor.id))).toEqual([]);
  });

  it("binds click areas to an anchor and refuses to draw one with nothing to bind", async () => {
    const { base, view, sources } = await fixture();
    const salon = base.spaces.find((candidate) => candidate.id === "salon")!;
    const room = space(view, salon.id).rooms[0]!;
    const area = addPolygonShape(view, sources, salon.id, room.id, "click_area", rect(200, 200, 80, 80));
    if (!area.ok) throw new Error(area.error);
    const stored = effectiveRoomAuthoring(view, sources, salon.id, room).clickAreas.find((value) => value.id === area.ref.id)!;
    expect("anchorId" in stored.target).toBe(true);
    const bare = interiorEditingView({ ...base, spaces: base.spaces }) as AuthoringView;
    const emptyRoom = space(bare, salon.id).rooms[0]!;
    emptyRoom.anchors = emptyRoom.anchors.filter((anchor) => anchor.id === emptyRoom.spawnAnchorId);
    emptyRoom.objects = [];
    const refused = addPolygonShape(bare, sources, salon.id, emptyRoom.id, "click_area", rect(200, 200, 80, 80));
    expect(refused.ok).toBe(false);
  });

  it("retires published shapes and removes shapes that were never published", async () => {
    const { base, view, sources } = await fixture();
    const manor = base.spaces.find((candidate) => candidate.id === "manor_lobby")!;
    const stored = manor.rooms[0]!;
    const room = space(view, manor.id).rooms[0]!;
    const publishedArea = stored.clickAreas.find((area) => !area.retired);
    if (publishedArea) {
      expect(retireShape(view, sources, manor.id, room.id, { kind: "clickArea", id: publishedArea.id })).toBe(true);
      expect(effectiveRoomAuthoring(view, sources, manor.id, room).clickAreas.find((area) => area.id === publishedArea.id)?.retired).toBe(true);
    }
    const drawn = addPolygonShape(view, sources, manor.id, room.id, "collider", rect(400, 400, 50, 50));
    if (!drawn.ok) throw new Error(drawn.error);
    const floor = addPolygonShape(view, sources, manor.id, room.id, "floor", rect(40, 40, 300, 300));
    if (!floor.ok) throw new Error(floor.error);
    expect(retireShape(view, sources, manor.id, room.id, drawn.ref)).toBe(true);
    expect(room.colliders.some((collider) => collider.id === drawn.ref.id)).toBe(false);
    expect(retireShape(view, sources, manor.id, room.id, floor.ref)).toBe(true);
    expect(effectiveRoomAuthoring(view, sources, manor.id, room).floors.some((value) => value.id === floor.ref.id)).toBe(false);
    for (const original of stored.floors) {
      expect(effectiveRoomAuthoring(view, sources, manor.id, room).floors.some((value) => value.id === original.id)).toBe(true);
    }
  });

  it("changes an anchor's role, keeps message text, and turns a spawn only by choosing another", async () => {
    const { base, view, sources } = await fixture();
    const salon = base.spaces.find((candidate) => candidate.id === "salon")!;
    const room = space(view, salon.id).rooms[0]!;
    room.anchors.push({ id: "note", retired: false, x: 500, y: 500 });
    expect(anchorRoleOf(view, sources, salon.id, room, "note")).toBe("point");
    expect(setAnchorRole(view, sources, salon.id, room.id, "note", "message").ok).toBe(true);
    expect(setAnchorMessage(view, sources, salon.id, room.id, "note", "The sign is faded.")).toBe(true);
    const out = exported(base, view, salon.id).rooms[0]!.anchors.find((anchor) => anchor.id === "note")!;
    expect(out).toMatchObject({ role: "message", message: "The sign is faded." });
    expect(interiorViewIssues(base, {}, view).filter((issue) => issue.path.includes(salon.id))).toEqual([]);
    // Message text is required.
    setAnchorMessage(view, sources, salon.id, room.id, "note", "");
    expect(interiorViewIssues(base, {}, view).some((issue) => issue.message.includes("message anchor requires message text"))).toBe(true);
    setAnchorMessage(view, sources, salon.id, room.id, "note", "Back again.");
    expect(setAnchorRole(view, sources, salon.id, room.id, "note", "point").ok).toBe(true);
    expect(exported(base, view, salon.id).rooms[0]!.anchors.find((anchor) => anchor.id === "note")).toMatchObject({ role: "point" });
    expect(exported(base, view, salon.id).rooms[0]!.anchors.find((anchor) => anchor.id === "note")!.message).toBeUndefined();
    // Spawn moves; the old spawn becomes a point.
    const oldSpawn = room.spawnAnchorId;
    expect(setAnchorRole(view, sources, salon.id, room.id, oldSpawn, "point").ok).toBe(false);
    expect(setAnchorRole(view, sources, salon.id, room.id, "note", "spawn").ok).toBe(true);
    expect(room.spawnAnchorId).toBe("note");
    expect(exported(base, view, salon.id).rooms[0]!.anchors.find((anchor) => anchor.id === oldSpawn)).toMatchObject({ role: "point" });
    expect(interiorViewIssues(base, {}, view).filter((issue) => issue.path.includes(salon.id))).toEqual([]);
  });

  it("pairs a portal anchor with a new anchor in another room, creating both anchors and both portal records", async () => {
    const { base, view, sources } = await fixture();
    const manor = base.spaces.find((candidate) => candidate.id === "manor_lobby")!;
    const dungeon = space(view, manor.id);
    const [source, other] = dungeon.rooms.filter((room) => !room.retired && room.active);
    expect(source && other).toBeTruthy();
    source!.anchors.push({ id: "annex_door", retired: false, x: 500, y: 500 });
    expect(setAnchorRole(view, sources, manor.id, source!.id, "annex_door", "portal").ok).toBe(true);
    const portalsBefore = dungeon.portals.length;
    const paired = pairPortalAnchors(view, sources, manor.id, source!.id, "annex_door", { roomId: other!.id });
    if (!paired.ok) throw new Error(paired.error);
    expect(dungeon.portals.length).toBe(portalsBefore + 2);
    const forward = dungeon.portals.find((portal) => portal.id === paired.portalId)!;
    const reverse = dungeon.portals.find((portal) => portal.id === paired.reciprocalPortalId)!;
    expect(forward).toMatchObject({ retired: false, enabled: true, reciprocalPortalId: reverse.id, source: { kind: "room", roomId: source!.id, anchorId: "annex_door" }, destination: { kind: "room", roomId: other!.id, anchorId: paired.destinationAnchorId } });
    expect(reverse).toMatchObject({ reciprocalPortalId: forward.id, source: { kind: "room", roomId: other!.id, anchorId: paired.destinationAnchorId }, destination: { kind: "room", roomId: source!.id, anchorId: "annex_door" } });
    expect(anchorPortalLink(dungeon, source!.id, "annex_door")).toMatchObject({ destinationRoomId: other!.id, destinationAnchorId: paired.destinationAnchorId });
    // The created anchor exists, is a portal, and is reachable on the destination room's floors.
    expect(other!.anchors.some((anchor) => anchor.id === paired.destinationAnchorId)).toBe(true);
    const out = exported(base, view, manor.id);
    const outOther = out.rooms.find((room) => room.id === other!.id)!;
    expect(outOther.anchors.find((anchor) => anchor.id === paired.destinationAnchorId)).toMatchObject({ role: "portal" });
    const arrival = outOther.anchors.find((anchor) => anchor.id === paired.destinationAnchorId)!;
    const spawn = outOther.anchors.find((anchor) => anchor.id === outOther.spawnAnchorId)!;
    expect(findIndoorNavigationRoute(interiorNavigation(outOther), spawn, arrival)).not.toBeNull();
    expect(interiorViewIssues(base, {}, view).filter((issue) => issue.path.includes(manor.id))).toEqual([]);

    // Changing the source anchor away from Portal retires both records and returns the far anchor to a point.
    expect(setAnchorRole(view, sources, manor.id, source!.id, "annex_door", "message").ok).toBe(true);
    expect(dungeon.portals.find((portal) => portal.id === forward.id)).toMatchObject({ retired: true, enabled: false });
    expect(dungeon.portals.find((portal) => portal.id === reverse.id)).toMatchObject({ retired: true, enabled: false });
    expect(anchorRoleOf(view, sources, manor.id, other!, paired.destinationAnchorId)).toBe("point");
  });

  it("pairs dungeon anchors with door objects, since dungeon doors are objects", async () => {
    const { base, view, sources } = await fixture();
    const dungeonSpace = base.spaces.find((candidate) => candidate.kind === "dungeon" && candidate.rooms.filter((room) => !room.retired).length >= 2)!;
    const dungeon = space(view, dungeonSpace.id);
    const [source, other] = dungeon.rooms.filter((room) => !room.retired);
    source!.anchors.push({ id: "new_door", retired: false, x: source!.width / 2, y: source!.height / 2 });
    setAnchorRole(view, sources, dungeonSpace.id, source!.id, "new_door", "portal");
    const paired = pairPortalAnchors(view, sources, dungeonSpace.id, source!.id, "new_door", { roomId: other!.id });
    if (!paired.ok) throw new Error(paired.error);
    expect(source!.objects.some((object) => object.portalId === paired.portalId && object.type === "portal")).toBe(true);
    expect(other!.objects.some((object) => object.portalId === paired.reciprocalPortalId)).toBe(true);
    expect(interiorViewIssues(base, {}, view).filter((issue) => issue.path.includes(dungeonSpace.id))).toEqual([]);
  });

  it("refuses to pair when the anchor is unreachable on the floors, leaving the view untouched", async () => {
    const { base, view, sources } = await fixture();
    const manor = base.spaces.find((candidate) => candidate.id === "manor_lobby")!;
    const dungeon = space(view, manor.id);
    const [source, other] = dungeon.rooms.filter((room) => !room.retired && room.active);
    source!.anchors.push({ id: "off_floor", retired: false, x: source!.width - 2, y: source!.height - 2 });
    const before = JSON.stringify(view);
    const result = pairPortalAnchors(view, sources, manor.id, source!.id, "off_floor", { roomId: other!.id });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(view)).toBe(before);
    expect(pairPortalAnchors(view, sources, manor.id, source!.id, "off_floor", { roomId: source!.id }).ok).toBe(false);
    expect(pairPortalAnchors(view, sources, manor.id, source!.id, source!.spawnAnchorId, { roomId: other!.id }).ok).toBe(false);
  });

  it("retires an anchor with its portals and click areas, but refuses the spawn and anchors used by objects", async () => {
    const { base, view, sources } = await fixture();
    const manor = base.spaces.find((candidate) => candidate.id === "manor_lobby")!;
    const dungeon = space(view, manor.id);
    const [source, other] = dungeon.rooms.filter((room) => !room.retired && room.active);
    source!.anchors.push({ id: "temp_door", retired: false, x: 500, y: 500 });
    setAnchorRole(view, sources, manor.id, source!.id, "temp_door", "portal");
    const paired = pairPortalAnchors(view, sources, manor.id, source!.id, "temp_door", { roomId: other!.id });
    if (!paired.ok) throw new Error(paired.error);
    const area = addPolygonShape(view, sources, manor.id, source!.id, "click_area", rect(480, 480, 40, 40));
    if (!area.ok) throw new Error(area.error);
    updateClickArea(view, sources, manor.id, source!.id, area.ref.id, (value) => { value.target = { anchorId: "temp_door" }; });
    expect(retireAnchor(view, sources, manor.id, source!.id, source!.spawnAnchorId).ok).toBe(false);
    expect(retireAnchor(view, sources, manor.id, source!.id, "temp_door").ok).toBe(true);
    expect(source!.anchors.some((anchor) => anchor.id === "temp_door")).toBe(false);
    expect(dungeon.portals.find((portal) => portal.id === paired.portalId)!.retired).toBe(true);
    expect(dungeon.portals.find((portal) => portal.id === paired.reciprocalPortalId)!.retired).toBe(true);
    expect(effectiveRoomAuthoring(view, sources, manor.id, source!).clickAreas.some((value) => value.id === area.ref.id && !value.retired)).toBe(false);
  });
});
