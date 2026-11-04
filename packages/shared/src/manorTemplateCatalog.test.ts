import { describe, expect, it } from "vitest";

import {
  DEFAULT_MANOR_TEMPLATE_CATALOG,
  isManorDecorationPlacementValid,
  manorAnchorDestinations,
  manorCatalogValidationIssues,
  manorPolygonContainsPolygon,
  manorPolygonGeometryIssues,
  manorTemplateRoomNavigation,
  parseManorTemplateCatalog,
  resolveManorDecorationDragPosition
} from "./manorTemplateCatalog.js";

describe("Manor template catalog", () => {
  it("publishes SimpleDoubleBed as a free universal starter decoration", () => {
    const bed = DEFAULT_MANOR_TEMPLATE_CATALOG.templates.find((candidate) => candidate.id === "manor_lobby")!.decorations.find((decoration) =>
      decoration.id === "simple_double_bed"
    );
    expect(bed).toMatchObject({
      name: "SimpleDoubleBed",
      itemId: null,
      placementMode: "movable"
    });
    expect(manorCatalogValidationIssues(DEFAULT_MANOR_TEMPLATE_CATALOG)).toEqual([]);
  });

  it("parses the source-controlled lobby and maps its authored floor to indoor navigation", () => {
    expect(parseManorTemplateCatalog(structuredClone(DEFAULT_MANOR_TEMPLATE_CATALOG))).toEqual(
      DEFAULT_MANOR_TEMPLATE_CATALOG
    );
    const room = DEFAULT_MANOR_TEMPLATE_CATALOG.templates.find((candidate) => candidate.id === "manor_lobby")!.rooms[0]!;
    expect(manorTemplateRoomNavigation(room)).toMatchObject({
      roomWidth: 1254,
      roomHeight: 1254,
      playerRadius: 24,
      colliders: [],
      walkableSurfaces: [expect.arrayContaining([{ x: 72, y: 198 }])]
    });
    expect("navigationAreas" in room).toBe(false);
    expect(room.anchors.find((anchor) => anchor.id === "spawn")).toMatchObject({
      retired: false, facing: -Math.PI / 2, type: "spawn"
    });
    // One left door leads to two rooms, each named by its typed label.
    const doors = room.anchors.filter((anchor) => !anchor.retired && anchor.type === "portal");
    expect(doors).toHaveLength(1);
    expect(manorAnchorDestinations(doors[0]!).map((destination) => [destination.destinationRoomId, destination.label]))
      .toEqual([["upstairs_hallway", "Upstairs"], ["basement_hallway", "Basement"]]);
  });

  it("requires every door destination to lead back to the same door", () => {
    const broken = structuredClone(DEFAULT_MANOR_TEMPLATE_CATALOG) as unknown as { templates: Array<{ id: string; rooms: Array<{ id: string; anchors: Array<Record<string, unknown>> }> }> };
    const timber = broken.templates.find((template) => template.id === "manor_lobby")!;
    const lower = timber.rooms.find((candidate) => candidate.id === "basement_hallway")!;
    const back = lower.anchors.find((anchor) => anchor.id === "return_to_manor")!;
    back.destinationAnchorId = "spawn";
    back.destinations = [{ destinationRoomId: "manor_lobby_room", destinationAnchorId: "spawn", label: "Lobby", locked: false }];
    expect(manorCatalogValidationIssues(broken).map((issue) => issue.message)).toEqual(expect.arrayContaining([
      "portal pairing must be reciprocal"
    ]));
  });

  it("keeps authored anchors and portal hotspots out of navigation colliders", () => {
    const room = DEFAULT_MANOR_TEMPLATE_CATALOG.templates.find((candidate) => candidate.id === "manor_lobby")!.rooms[0]!;
    const interactiveIds = new Set([
      ...room.anchors.map((anchor) => anchor.id),
      ...room.portalHotspots.map((hotspot) => hotspot.id)
    ]);
    expect(room.colliders.filter((collider) => interactiveIds.has(collider.id))).toEqual([]);
    expect(manorTemplateRoomNavigation(room).colliders).toEqual([]);
  });

  it("accepts concave simple polygons and rejects malformed geometry", () => {
    const valid = structuredClone(DEFAULT_MANOR_TEMPLATE_CATALOG);
    valid.templates[0]!.rooms[0]!.placementSurfaces[0] = {
      ...valid.templates[0]!.rooms[0]!.placementSurfaces[0]!,
      polygon: [
        { x: 120, y: 180 }, { x: 1134, y: 180 }, { x: 1134, y: 1120 },
        { x: 700, y: 1120 }, { x: 700, y: 700 }, { x: 520, y: 700 },
        { x: 520, y: 1120 }, { x: 120, y: 1120 }
      ]
    } as typeof valid.templates[0]["rooms"][0]["placementSurfaces"][0];
    valid.templates[0]!.rooms[0]!.anchors[0]!.x = 300;
    expect(manorCatalogValidationIssues(valid)).toEqual([]);

    const adjacentDuplicate = structuredClone(valid);
    adjacentDuplicate.templates[0]!.rooms[0]!.placementSurfaces[0] = {
      ...adjacentDuplicate.templates[0]!.rooms[0]!.placementSurfaces[0]!,
      polygon: [
        { x: 120, y: 180 }, { x: 1134, y: 180 }, { x: 1134, y: 1120 },
        { x: 1134, y: 1120 }, { x: 120, y: 1120 }
      ]
    } as typeof adjacentDuplicate.templates[0]["rooms"][0]["placementSurfaces"][0];
    expect(manorPolygonGeometryIssues((adjacentDuplicate.templates[0]!.rooms[0]!.placementSurfaces[0] as { polygon: Array<{ x: number; y: number }> }).polygon)).toEqual([
      "polygon may not contain adjacent duplicate vertices"
    ]);

    const selfIntersecting = structuredClone(valid);
    selfIntersecting.templates[0]!.rooms[0]!.placementSurfaces[0] = {
      ...selfIntersecting.templates[0]!.rooms[0]!.placementSurfaces[0]!,
      polygon: [
      { x: 120, y: 180 }, { x: 1134, y: 180 }, { x: 120, y: 1120 },
      { x: 1134, y: 1120 }, { x: 728, y: 650 }
      ]
    } as typeof selfIntersecting.templates[0]["rooms"][0]["placementSurfaces"][0];
    expect(manorCatalogValidationIssues(selfIntersecting)).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "polygon must not self-intersect" })
    ]));

    const mismatchedMapping = structuredClone(valid);
    const backWall = mismatchedMapping.templates[0]!.rooms[0]!.placementSurfaces.find(
      (surface) => surface.kind === "back_wall"
    );
    if (backWall?.kind === "back_wall") backWall.imagePolygon = backWall.imagePolygon.slice(0, -1);
    expect(manorCatalogValidationIssues(mismatchedMapping)).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "must have one normalized point for each room polygon vertex" })
    ]));
    expect(manorPolygonGeometryIssues([
      { x: 0, y: 0 }, { x: Number.POSITIVE_INFINITY, y: 1 }, { x: 1, y: 0 }
    ])).toEqual(["polygon coordinates must be finite"]);
  });

  it("checks full transformed polygon containment, including concave notches", () => {
    const concave = [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 },
      { x: 6, y: 10 }, { x: 6, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 10 }, { x: 0, y: 10 }
    ];
    expect(manorPolygonContainsPolygon(concave, [
      { x: 1, y: 1 }, { x: 3, y: 1 }, { x: 3, y: 3 }, { x: 1, y: 3 }
    ])).toBe(true);
    expect(manorPolygonContainsPolygon(concave, [
      { x: 4.5, y: 5 }, { x: 5.5, y: 5 }, { x: 5.5, y: 9 }, { x: 4.5, y: 9 }
    ])).toBe(false);
  });

  it("requires walk-test endpoints and segments to remain inside authored floor polygons", () => {
    const room = structuredClone(DEFAULT_MANOR_TEMPLATE_CATALOG).templates.find((template) => template.id === "manor_lobby")!.rooms[0]!;
    const navigation = manorTemplateRoomNavigation(room);
    expect(navigation.walkableSurfaces).toHaveLength(1);
    expect(navigation.walkableSurfaces?.[0]).toEqual(expect.arrayContaining([
      { x: 72, y: 198 }
    ]));
    expect(() => parseManorTemplateCatalog({
      ...structuredClone(DEFAULT_MANOR_TEMPLATE_CATALOG),
      templates: [{
        ...structuredClone(DEFAULT_MANOR_TEMPLATE_CATALOG).templates.find((template) => template.id === "manor_lobby")!,
        rooms: [{
          ...room,
          anchors: [{ ...room.anchors[0]!, x: 10 }]
        }]
      }]
    })).toThrow(/walkable floor surface/u);
  });

  it("validates reciprocal portal anchors and portal hotspot bindings", () => {
    const catalog = structuredClone(DEFAULT_MANOR_TEMPLATE_CATALOG);
    const template = catalog.templates[0]!;
    const room = template.rooms[0]!;
    room.anchors.push(
      { id: "north_portal", retired: false, x: 300, y: 220, type: "portal", destinationRoomId: room.id, destinationAnchorId: "south_portal" },
      { id: "south_portal", retired: false, x: 300, y: 300, type: "portal", destinationRoomId: room.id, destinationAnchorId: "north_portal" }
    );
    room.portalHotspots.push({
      id: "north_hotspot",
      retired: false,
      polygon: [{ x: 270, y: 190 }, { x: 330, y: 190 }, { x: 330, y: 240 }, { x: 270, y: 240 }],
      anchorId: "north_portal",
      interactionLabel: "Use portal"
    });
    expect(manorCatalogValidationIssues(catalog)).toEqual([]);
    room.anchors.find((anchor) => anchor.id === "north_portal")!.destinationAnchorId = "spawn";
    expect(manorCatalogValidationIssues(catalog)).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "destination anchor must be a portal anchor" })
    ]));
    room.anchors.find((anchor) => anchor.id === "north_portal")!.destinationAnchorId = "south_portal";
    room.portalHotspots.find((hotspot) => hotspot.id === "north_hotspot")!.anchorId = "spawn";
    expect(manorCatalogValidationIssues(catalog)).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "must bind to an active interaction anchor" })
    ]));
  });

  it("supports message anchors without destinations and requires authored text", () => {
    const catalog = structuredClone(DEFAULT_MANOR_TEMPLATE_CATALOG);
    const room = catalog.templates[0]!.rooms[0]!;
    room.anchors.push({ id: "test_message", type: "message", retired: false, x: 627, y: 700, message: "Hello" });
    room.portalHotspots.push({
      id: "message_hotspot",
      retired: false,
      polygon: [{ x: 570, y: 120 }, { x: 684, y: 120 }, { x: 684, y: 180 }, { x: 570, y: 180 }],
      anchorId: "test_message",
      interactionLabel: "Message"
    });
    expect(manorCatalogValidationIssues(catalog)).toEqual([]);
    const missingText = structuredClone(catalog);
    const messageAnchor = missingText.templates[0]!.rooms[0]!.anchors.find((anchor) => anchor.id === "test_message")!;
    Reflect.deleteProperty(messageAnchor, "message");
    expect(manorCatalogValidationIssues(missingText)).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "message anchor requires message text" })
    ]));
    const destination = structuredClone(catalog);
    const destinationAnchor = destination.templates[0]!.rooms[0]!.anchors.find((anchor) => anchor.id === "test_message")!;
    destinationAnchor.destinationRoomId = room.id;
    destinationAnchor.destinationAnchorId = "spawn";
    expect(manorCatalogValidationIssues(destination)).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "message anchor cannot have a destination anchor" })
    ]));
  });

  it("slides a transformed movable footprint along arbitrary surface and collision edges", () => {
    const surface = {
      id: "floor",
      retired: false,
      kind: "floor" as const,
      polygon: [{ x: 0, y: 0 }, { x: 500, y: 0 }, { x: 500, y: 500 }, { x: 0, y: 500 }]
    };
    const decoration = {
      footprint: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 }],
      mirrorX: false,
      collision: true
    };
    const currentTransform = {
      x: 100, y: 100, width: 20, height: 20, rotationDeg: 0,
      scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5
    };
    const resolved = resolveManorDecorationDragPosition({
      decoration,
      surface,
      currentTransform,
      requestedPosition: { x: 240, y: 320 },
      collisionPolygons: [[
        { x: 200, y: 50 }, { x: 250, y: 50 }, { x: 250, y: 450 }, { x: 200, y: 450 }
      ]]
    });
    expect(resolved.x).toBeLessThan(200);
    expect(resolved.y).toBeGreaterThan(100);
    expect(isManorDecorationPlacementValid(
      decoration,
      surface,
      { ...currentTransform, ...resolved },
      [[{ x: 200, y: 50 }, { x: 250, y: 50 }, { x: 250, y: 450 }, { x: 200, y: 450 }]]
    )).toBe(true);
  });

  it("migrates the legacy navigation and exit-anchor shape without retaining active exits", () => {
    type LegacyRoom = {
      anchors: Array<Record<string, unknown>>;
      portalHotspots: Array<Record<string, unknown>>;
      navigationAreas?: Array<Record<string, unknown>>;
    };
    type LegacyCatalog = { schemaVersion: number; templates: Array<{ rooms: LegacyRoom[] }> };
    const legacy = structuredClone(DEFAULT_MANOR_TEMPLATE_CATALOG) as unknown as LegacyCatalog;
    legacy.schemaVersion = 1;
    const room = legacy.templates[0]!.rooms[0]!;
    delete room.anchors[0]!.type;
    room.anchors.push({ id: "legacy_exit", retired: false, x: 627, y: 1120, facing: Math.PI / 2 });
    room.portalHotspots.push({
      id: "legacy_exit_hotspot",
      retired: false,
      polygon: [{ x: 577, y: 1080 }, { x: 677, y: 1080 }, { x: 677, y: 1160 }, { x: 577, y: 1160 }],
      anchorId: "legacy_exit",
      interactionLabel: "Return to world"
    });
    room.navigationAreas = [{
      id: "legacy_navigation",
      retired: false,
      polygon: [{ x: 120, y: 180 }, { x: 1134, y: 180 }, { x: 1134, y: 1120 }, { x: 120, y: 1120 }]
    }];

    const migrated = parseManorTemplateCatalog(legacy);
    const migratedRoom = migrated.templates[0]!.rooms[0]!;
    expect(migrated.schemaVersion).toBe(3);
    expect("navigationAreas" in migratedRoom).toBe(false);
    expect(migratedRoom.anchors.find((anchor) => anchor.id === "legacy_exit")).toMatchObject({
      type: "portal",
      retired: true
    });
    expect(migratedRoom.portalHotspots.find((hotspot) => hotspot.id === "legacy_exit_hotspot")).toMatchObject({ retired: true });

    const priorMessageCatalog = structuredClone(DEFAULT_MANOR_TEMPLATE_CATALOG) as unknown as LegacyCatalog;
    priorMessageCatalog.schemaVersion = 2;
    priorMessageCatalog.templates[0]!.rooms[0]!.navigationAreas = [{
      id: "stale_navigation",
      retired: false,
      polygon: [{ x: 120, y: 180 }, { x: 1134, y: 180 }, { x: 1134, y: 1120 }]
    }];
    const upgraded = parseManorTemplateCatalog(priorMessageCatalog);
    expect(upgraded.schemaVersion).toBe(3);
    expect("navigationAreas" in upgraded.templates[0]!.rooms[0]!).toBe(false);
  });
});
