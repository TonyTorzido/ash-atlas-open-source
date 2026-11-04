import { readFileSync } from "node:fs";
import { interiorCatalogFromLegacy } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { interiorEditingView } from "./interiorStudioModel.js";
import {
  anchorNames,
  describeSelection,
  layoutLabels,
  movementProfileText,
  panToPoint,
  prefabArtFamily,
  prefabMatchesInteriorKind,
  selectionPoint,
  toolForKey
} from "./interiorStudioUx.js";

const view = interiorEditingView(interiorCatalogFromLegacy());
const dungeon = view.dungeons.find((value) => value.rooms.some((room) => dungeon_hasDoor(value, room.id)))!;
function dungeon_hasDoor(value: (typeof view.dungeons)[number], roomId: string): boolean {
  return value.portals.some((portal) => !portal.retired && portal.source.kind === "room" && portal.source.roomId === roomId);
}

describe("canvas tool shortcuts", () => {
  it("maps each tool key case-insensitively and ignores other keys", () => {
    expect(["v", "h", "f", "w", "c", "k", "a", "p"].map((key) => toolForKey(key))).toEqual(["select", "pan", "floor", "wall", "collider", "clickArea", "anchor", "place"]);
    expect(toolForKey("F")).toBe("floor");
    expect(toolForKey("x")).toBeNull();
    expect(toolForKey("Enter")).toBeNull();
  });
});

describe("canvas label naming", () => {
  it("names doors by destination, the spawn and the world exit instead of raw ids", () => {
    const room = dungeon.rooms.find((value) => dungeon_hasDoor(dungeon, value.id))!;
    const names = anchorNames({ room, dungeon, prefabs: view.prefabs });
    const leaving = dungeon.portals.filter((portal) => !portal.retired && portal.source.kind === "room" && portal.source.roomId === room.id);
    for (const portal of leaving) {
      const anchorId = portal.source.kind === "room" ? portal.source.anchorId : "";
      const expected = portal.destination.kind === "world" ? "Exit to world" : /^Door → .+/u;
      const name = names.get(anchorId)!;
      if (typeof expected === "string") expect(name).toBe(expected); else expect(name).toMatch(expected);
      expect(name).not.toBe(anchorId);
    }
    if (room.spawnAnchorId) expect(names.get(room.spawnAnchorId)).toBe("Spawn");
    for (const [id, name] of names) expect(name, id).not.toMatch(/_/u);
  });

  it("describes a selection with a friendly type and name", () => {
    const room = dungeon.rooms.find((value) => value.objects.some((object) => !object.retired))!;
    const object = room.objects.find((value) => !value.retired)!;
    const summary = describeSelection({ room, dungeon, prefabs: view.prefabs }, { kind: "object", id: object.id })!;
    expect(summary.type).not.toMatch(/_/u);
    expect(summary.name.length).toBeGreaterThan(0);
    expect(describeSelection({ room, dungeon, prefabs: view.prefabs }, { kind: "collider", id: "missing" })).toBeNull();
    expect(describeSelection({ room, dungeon, prefabs: view.prefabs }, { kind: "mob", id: "x" })).toBeNull();
  });
});

describe("label collision avoidance", () => {
  const options = { fontSize: 14, roomWidth: 1000, roomHeight: 1000 };
  it("skips a lower-priority label that would overlap a placed one", () => {
    const placed = layoutLabels([
      { key: "low", text: "Point 1", x: 100, y: 100, priority: 10 },
      { key: "high", text: "Spawn", x: 105, y: 104, priority: 90 },
      { key: "far", text: "Door → Depths", x: 600, y: 600, priority: 10 }
    ], options);
    expect(placed.map((label) => label.key)).toEqual(["high", "far"]);
  });

  it("flips a label to the left of its point near the room's right edge", () => {
    const [label] = layoutLabels([{ key: "edge", text: "Exit to world", x: 960, y: 500, priority: 1 }], options);
    expect(label?.textAnchor).toBe("end");
    expect(label!.tx).toBeLessThan(960);
  });
});

describe("label collision, profile text and overlay styling", () => {
  it("keeps a door label off the neighbouring point marker and label", () => {
    const placed = layoutLabels([
      { key: "door", text: "Door → Sewer Depths", x: 430, y: 500, priority: 50 },
      { key: "point", text: "Point 2", x: 505, y: 500, priority: 30 }
    ], { fontSize: 14, roomWidth: 1000, roomHeight: 1000 });
    const door = placed.find((label) => label.key === "door");
    expect(door?.textAnchor).toBe("end");
    const point = placed.find((label) => label.key === "point");
    if (point) expect(point.tx).toBeGreaterThan(430);
  });

  it("words movement from the space kind without naming dungeons for non-dungeons", () => {
    expect(movementProfileText("dungeon")).toContain("half speed");
    expect(movementProfileText("dungeon")).toContain("130 units");
    expect(movementProfileText("manor")).toContain("260 units");
    expect(movementProfileText("manor")).not.toMatch(/dungeon/iu);
  });

  it("draws floor, wall and click-area overlays translucent and before objects", () => {
    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    for (const name of ["interior-floor", "interior-wall", "interior-click-area"]) {
      const rule = css.slice(css.indexOf(`.${name} { fill: rgba(`));
      const alpha = Number(rule.slice(rule.indexOf("rgba("), rule.indexOf(")")).split(",").pop());
      expect(alpha).toBeGreaterThan(0);
      expect(alpha).toBeLessThanOrEqual(0.2);
    }
    const source = readFileSync(new URL("./InteriorStudio.tsx", import.meta.url), "utf8");
    expect(source.indexOf("interior-floor")).toBeLessThan(source.indexOf("SvgPrefabArt key={value.id}"));
    expect(source.indexOf("interior-click-area ")).toBeLessThan(source.indexOf("SvgPrefabArt key={value.id}"));
  });
});

describe("library art families", () => {
  it("keeps kind-specific art to its kind and shows shared art everywhere", () => {
    const byId = (id: string) => view.prefabs.find((prefab) => prefab.id === id)!;
    expect(prefabArtFamily(byId("sewer_floor"))).toBe("dungeon");
    expect(prefabArtFamily(byId("manor_lobby_theme_floor"))).toBe("manor");
    expect(prefabArtFamily(byId("greenhouse_pot"))).toBe("greenhouse");
    expect(prefabArtFamily(byId("dungeon_chest"))).toBe("shared");
    expect(prefabMatchesInteriorKind(byId("sewer_floor"), "manor")).toBe(false);
    expect(prefabMatchesInteriorKind(byId("manor_lobby_theme_floor"), "manor")).toBe(true);
    expect(prefabMatchesInteriorKind(byId("manor_lobby_theme_floor"), "dungeon")).toBe(false);
    expect(prefabMatchesInteriorKind(byId("dungeon_chest"), "salon")).toBe(true);
    expect(prefabMatchesInteriorKind({ id: "custom_rug", assetKey: "apps/client/public/assets/dungeons/custom/rug.png" }, "dungeon")).toBe(true);
  });
});

describe("focusing a selection", () => {
  it("finds an anchor's point and pans it to the middle of the canvas", () => {
    const room = dungeon.rooms.find((value) => value.anchors.some((anchor) => !anchor.retired))!;
    const anchor = room.anchors.find((value) => !value.retired)!;
    expect(selectionPoint(room, null, { kind: "anchor", id: anchor.id })).toEqual(expect.objectContaining({ x: anchor.x, y: anchor.y }));
    expect(selectionPoint(room, null, { kind: "anchor", id: "missing" })).toBeNull();
    const size = { width: 700, height: 700 };
    expect(panToPoint({ x: 500, y: 500 }, { width: 1000, height: 1000 }, size, 1)).toEqual({ x: -0, y: -0 });
    expect(panToPoint({ x: 1000, y: 0 }, { width: 1000, height: 1000 }, size, 2)).toEqual({ x: -700, y: 700 });
  });
});
