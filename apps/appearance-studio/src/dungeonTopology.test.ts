import { DUNGEON_CATALOG, dungeonCatalogValidationIssues, type DungeonDefinition } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";
import { createDungeonFromWizard } from "./dungeonStudioV2.js";
import { buildDungeonTopology, connectDungeonAnchors, findDungeonTopologyRoute, layoutDungeonTopology, topologyNodeHeight, topologyPortPoint, visibleTopologyPorts } from "./dungeonTopology.js";

const prefab = DUNGEON_CATALOG.prefabs.find((value) => !value.retired && value.type === "portal")!;
function sewer(): DungeonDefinition { return structuredClone(DUNGEON_CATALOG.dungeons.find((entry) => entry.id === "cistern_warrens")!); }

function branchDungeon(): DungeonDefinition {
  const dungeon = createDungeonFromWizard(DUNGEON_CATALOG, { name: "Topology Test", themeId: "stone", backgroundColor: "#071116", floorColor: "#182a2d", wallColor: "#405052", accentColor: "#8fbc8f", instancePolicy: "party_ephemeral", resetPolicy: "when_empty", width: 1000, height: 1000 });
  const start = dungeon.rooms[0]!;
  for (const id of ["left", "right", "end"]) {
    dungeon.rooms.push({ ...structuredClone(start), id, name: id, anchors: [{ id: "spawn", retired: false, x: 500, y: 500 }], spawnAnchorId: "spawn", objects: [], mobs: [] });
  }
  for (const [from, to] of [[start.id, "left"], [start.id, "right"], ["left", "end"], ["right", "end"]]) {
    const source = dungeon.rooms.find((room) => room.id === from)!; const destination = dungeon.rooms.find((room) => room.id === to)!;
    connectDungeonAnchors(dungeon, { roomId: source.id, anchorId: source.spawnAnchorId }, { roomId: destination.id, anchorId: destination.spawnAnchorId }, prefab, true);
  }
  return dungeon;
}

describe("dungeon topology uses authored portal authority", () => {
  it("derives canonical room nodes, actual anchors, Start, Exit and boss without changing data", () => {
    const dungeon = sewer(); const before = structuredClone(dungeon);
    const model = buildDungeonTopology(dungeon);
    expect(model.rooms.map((room) => room.roomId)).toEqual(dungeon.rooms.filter((room) => !room.retired).map((room) => room.id));
    for (const room of model.rooms) expect(room.ports.map((port) => port.anchorId)).toEqual(room.room.anchors.filter((anchor) => !anchor.retired).map((anchor) => anchor.id));
    expect(model.edges.map((edge) => edge.portalId)).toEqual(dungeon.portals.filter((portal) => !portal.retired).map((portal) => portal.id));
    expect(model.rooms.find((room) => room.start)?.roomId).toBe(dungeon.entrance.roomId);
    expect(model.rooms.some((room) => room.exit)).toBe(true);
    expect(model.rooms.filter((room) => room.boss).map((room) => room.roomId)).toEqual([...new Set(dungeon.encounters.filter((encounter) => !encounter.retired && encounter.bossTemplateId).map((encounter) => encounter.roomId))]);
    expect(model.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(model.rooms.every((room) => room.reachable)).toBe(true);
    expect(dungeon).toEqual(before);
  });

  it("keeps a missing destination visible and identifies the exact portal and anchor", () => {
    const dungeon = sewer(); const portal = dungeon.portals.find((value) => value.id === "hatch-to-overflow")!;
    if (portal.destination.kind !== "room") throw new Error("Fixture requires a room destination");
    portal.destination.anchorId = "deleted_anchor";
    const model = buildDungeonTopology(dungeon);
    expect(model.edges.find((edge) => edge.portalId === portal.id)?.valid).toBe(false);
    expect(model.issues).toContainEqual(expect.objectContaining({ code: "missing_anchor", portalId: portal.id, anchorId: "deleted_anchor", roomId: "overflow_channel", severity: "error" }));
    expect(findDungeonTopologyRoute(model, "overflow_channel").distance).toBeNull();
  });

  it("detects deleted rooms and required encounter references instead of dropping broken edges", () => {
    const dungeon = sewer(); dungeon.rooms = dungeon.rooms.filter((room) => room.id !== "overflow_channel");
    const model = buildDungeonTopology(dungeon);
    expect(model.rooms.some((room) => room.roomId === "overflow_channel")).toBe(false);
    expect(model.edges.some((edge) => edge.portalId === "hatch-to-overflow")).toBe(true);
    expect(model.issues.some((issue) => issue.code === "missing_room" && issue.roomId === "overflow_channel")).toBe(true);
    expect(model.issues.some((issue) => issue.code === "missing_encounter_room" && issue.roomId === "overflow_channel")).toBe(true);
    expect(model.rooms.find((room) => room.roomId === "warden_junction")?.reachable).toBe(false);
  });

  it("respects travel direction, disabled links and the required source portal object", () => {
    const dungeon = sewer(); dungeon.portals.find((portal) => portal.id === "hatch-to-overflow")!.enabled = false;
    const model = buildDungeonTopology(dungeon);
    expect(model.issues.some((issue) => issue.code === "directed_unreachable" && issue.roomId === "overflow_channel")).toBe(true);
    expect(findDungeonTopologyRoute(model, "warden_junction").distance).toBeNull();
    dungeon.portals.find((portal) => portal.id === "hatch-to-overflow")!.enabled = true;
    dungeon.rooms[0]!.objects = dungeon.rooms[0]!.objects.filter((object) => object.portalId !== "hatch-to-overflow");
    expect(buildDungeonTopology(dungeon).issues).toContainEqual(expect.objectContaining({ code: "missing_portal_object", portalId: "hatch-to-overflow" }));
    expect(findDungeonTopologyRoute(buildDungeonTopology(dungeon), "warden_junction").distance).toBeNull();
  });

  it("reports unreachable exits and bosses and a one-way trap with no world recovery", () => {
    const dungeon = sewer();
    dungeon.portals.find((portal) => portal.id === "warden-to-cistern")!.enabled = false;
    dungeon.portals.find((portal) => portal.id === "brood-to-world")!.enabled = false;
    const model = buildDungeonTopology(dungeon);
    expect(model.issues.some((issue) => issue.code === "no_recovery" && issue.roomId === "warden_junction")).toBe(true);
    expect(model.edges.find((edge) => edge.portalId === "cistern-to-warden")?.oneWay).toBe(true);
    dungeon.portals.find((portal) => portal.id === "hatch-to-overflow")!.enabled = false;
    const bossModel = buildDungeonTopology(dungeon);
    expect(bossModel.issues.some((issue) => issue.code === "unreachable_boss")).toBe(true);
    const exit = dungeon.portals.find((portal) => portal.id === dungeon.escape.portalId)!;
    if (exit.source.kind !== "room") throw new Error("Fixture requires an exit room");
    exit.source.roomId = "warden_junction";
    expect(buildDungeonTopology(dungeon).issues.some((issue) => issue.code === "unreachable_exit")).toBe(true);
  });

  it("rejects a missing Start, duplicate identities, broken reciprocal and same-anchor self links", () => {
    const dungeon = sewer(); dungeon.entrance.arrivalAnchorId = "missing_start";
    const model = buildDungeonTopology(dungeon);
    expect(model.startRoomId).toBeNull();
    expect(model.issues.some((issue) => issue.code === "invalid_start")).toBe(true);
    expect(findDungeonTopologyRoute(model, dungeon.rooms[0]!.id).distance).toBeNull();
    const broken = sewer(); const room = broken.rooms[0]!;
    room.anchors.push(structuredClone(room.anchors[0]!));
    broken.rooms.push(structuredClone(room));
    const portal = broken.portals.find((value) => value.id === "hatch-to-overflow")!;
    portal.destination = structuredClone(portal.source);
    portal.reciprocalPortalId = "missing_reverse";
    broken.portals.push(structuredClone(portal));
    const codes = buildDungeonTopology(broken).issues.map((issue) => issue.code);
    expect(codes).toEqual(expect.arrayContaining(["duplicate_anchor", "duplicate_room", "duplicate_portal", "self_connection", "mismatched_reciprocal"]));
  });

  it("checks canonical walkable approach/arrival geometry without rejecting a wall threshold", () => {
    const dungeon = sewer(); const room = dungeon.rooms[0]!;
    const portal = dungeon.portals.find((value) => value.id === "hatch-to-overflow")!;
    const approach = room.anchors.find((anchor) => anchor.id === portal.sourceApproachAnchorId)!;
    room.colliders.push({ id: "test_block", kind: "rectangle", retired: false, x: approach.x - 20, y: approach.y - 20, width: 40, height: 40 });
    expect(buildDungeonTopology(dungeon).issues.some((issue) => issue.code === "blocked_anchor" && issue.anchorId === approach.id)).toBe(true);
    const clean = sewer(); const thresholdPortal = clean.portals.find((value) => value.id === "hatch-to-overflow")!;
    const thresholdRoom = clean.rooms[0]!;
    thresholdRoom.anchors.push({ id: "wall_threshold", retired: false, x: 0, y: 100 });
    thresholdPortal.sourceThresholdAnchorId = "wall_threshold";
    expect(buildDungeonTopology(clean).issues.some((issue) => issue.code === "blocked_anchor" && issue.anchorId === "wall_threshold")).toBe(false);
  });

  it("highlights every shortest route through branches and preserves explicit gate limitations", () => {
    const dungeon = branchDungeon(); const first = dungeon.portals.find((portal) => portal.source.kind === "room" && portal.destination.kind === "room")!;
    first.gates = [{ type: "item_owned", itemId: "coal", quantity: 1 }];
    const model = buildDungeonTopology(dungeon); const route = findDungeonTopologyRoute(model, "end");
    expect(route.distance).toBe(2); expect(route.alternativeCount).toBe(2);
    expect(route.roomIds).toEqual(expect.arrayContaining([dungeon.entrance.roomId, "left", "right", "end"]));
    expect(route.portalIds).toHaveLength(4); expect(route.conditional).toBe(true);
    expect(model.issues.some((issue) => issue.code === "conditional_routes" && issue.severity === "info")).toBe(true);
    expect(findDungeonTopologyRoute(model, dungeon.entrance.roomId).distance).toBe(0);
  });

  it("connects selected real anchors with actual reciprocal portals and valid source objects", () => {
    const dungeon = branchDungeon(); const before = structuredClone(dungeon.rooms.map((room) => ({ anchors: room.anchors, camera: room.camera, width: room.width, height: room.height })));
    const id = connectDungeonAnchors(dungeon, { roomId: "left", anchorId: "spawn" }, { roomId: "right", anchorId: "spawn" }, prefab, true);
    const edge = dungeon.portals.find((portal) => portal.id === id)!;
    expect(edge.reciprocalPortalId).toBeTruthy();
    expect(dungeon.rooms.find((room) => room.id === "left")!.objects.some((object) => object.type === "portal" && object.portalId === id && object.available)).toBe(true);
    expect(dungeon.rooms.map((room) => ({ anchors: room.anchors, camera: room.camera, width: room.width, height: room.height }))).toEqual(before);
    const catalog = structuredClone(DUNGEON_CATALOG); catalog.dungeons.push(dungeon);
    expect(dungeonCatalogValidationIssues(catalog)).toEqual([]);
    expect(buildDungeonTopology(dungeon).edges.find((value) => value.portalId === id)?.valid).toBe(true);
  });

  it("does not partially mutate data when a requested connection is incompatible or duplicated", () => {
    const dungeon = branchDungeon(); const before = structuredClone(dungeon);
    expect(() => connectDungeonAnchors(dungeon, { roomId: "left", anchorId: "spawn" }, { roomId: "left", anchorId: "spawn" }, prefab, true)).toThrow("another room");
    expect(() => connectDungeonAnchors(dungeon, { roomId: "left", anchorId: "spawn" }, { roomId: "end", anchorId: "spawn" }, prefab, true)).toThrow("already have");
    expect(() => connectDungeonAnchors(dungeon, { roomId: "left", anchorId: "missing" }, { roomId: "right", anchorId: "spawn" }, prefab, false)).toThrow("Both anchors");
    expect(dungeon).toEqual(before);
  });

  it("lays out rooms deterministically without modifying any dungeon geometry", () => {
    const dungeon = branchDungeon(); const before = structuredClone(dungeon); const model = buildDungeonTopology(dungeon);
    const layout = layoutDungeonTopology(model);
    expect(layout).toEqual(layoutDungeonTopology(model));
    expect(layout.end!.x).toBeGreaterThan(layout.left!.x);
    expect(layout.left!.y).not.toEqual(layout.right!.y);
    expect(dungeon).toEqual(before);
  });

  it("anchors edges to the centers of 44px rows and includes all rendered chrome in fit bounds", () => {
    const model = buildDungeonTopology(sewer());
    const entrance = model.rooms.find((room) => room.roomId === "hatch_landing")!;
    const ports = visibleTopologyPorts(entrance, false);
    // Node top70 + border1 + heading87 + counts44 + half of the first 44px row.
    expect(topologyPortPoint(entrance, { x: 180, y: 70 }, ports[0]!.anchorId, true, false)).toEqual({ x: 440, y: 224 });
    expect(topologyPortPoint(entrance, { x: 180, y: 70 }, ports[1]!.anchorId, false, false)).toEqual({ x: 180, y: 268 });
    expect(topologyPortPoint(entrance, { x: 180, y: 70 }, "door_e", true, false)).toEqual({ x: 440, y: 400 });
    expect(topologyNodeHeight(entrance, false)).toBe(485); // 2 borders + 87 + 44 + seven 44px ports + the 44px reveal control.
    const depths = model.rooms.find((room) => room.roomId === "overflow_channel")!;
    expect(visibleTopologyPorts(depths, false)).toHaveLength(7);
    expect(topologyNodeHeight(depths, false)).toBe(485); // Includes the 44px reveal control.
    expect(topologyNodeHeight(depths, true)).toBe(661); // Twelve ports (including the small-chest spot); no reveal control.
  });
});
