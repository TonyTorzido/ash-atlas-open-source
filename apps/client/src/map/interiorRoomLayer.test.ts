import { INTERIOR_SPATIAL_PROFILES, interiorMetersPerUnit, type DungeonObjectSnapshot } from "@ash-atlas/shared";
import { Container, Texture } from "pixi.js";
import { describe, expect, it, vi } from "vitest";

import {
  InteriorRoomLayer,
  interiorLocalToScreen,
  interiorRoomTransform,
  interiorScreenToLocal
} from "./interiorRoomLayer.js";
import type { InteriorRenderState } from "./mapObjects.js";

const METERS_PER_DEGREE = 2 * Math.PI * 6_371_008.8 / 360;
const metersPerUnit = interiorMetersPerUnit(INTERIOR_SPATIAL_PROFILES.dungeon);

/** A flat map at `pxPerDegree`, centred so lngLat (0, 0) lands on (100, 50). */
function fakeProject(pxPerDegree: number) {
  return vi.fn(([lon, lat]: [number, number]) => ({ x: 100 + lon * pxPerDegree, y: 50 - lat * pxPerDegree }));
}

function object(id: string, x: number, y: number): DungeonObjectSnapshot {
  return {
    id, kind: "valve", name: id, x, y, available: true, state: "idle",
    prefabId: "missing", prefabRevision: "1", layerId: "actors",
    interactionRadius: 40, rotationDeg: 0, opacity: 1, flipX: false, flipY: false, zIndex: 0
  };
}

function interiorState(objects: DungeonObjectSnapshot[]): InteriorRenderState {
  return {
    spaceKey: "dungeon:a:room",
    roomWidth: 1000,
    roomHeight: 1000,
    metersPerUnit,
    layers: { background: [], below_player: [], actors: [], above_player: [], ceiling: [] },
    prefabs: [],
    objects,
    players: [],
    combatEntities: [],
    selectedObjectId: null
  };
}

describe("interior room layer", () => {
  it("derives one similarity transform per frame from the room origin and one axis point", () => {
    const pxPerDegree = 1_000_000;
    const project = fakeProject(pxPerDegree);
    const transform = interiorRoomTransform(project, { roomWidth: 1000, metersPerUnit });
    expect(project).toHaveBeenCalledTimes(2);
    expect(transform.x).toBeCloseTo(100, 9);
    expect(transform.y).toBeCloseTo(50, 9);
    expect(transform.rotation).toBeCloseTo(0, 12);
    expect(transform.scale).toBeCloseTo(metersPerUnit / METERS_PER_DEGREE * pxPerDegree, 9);
    // Local +y is down on screen: the room renders upright.
    const bottom = interiorLocalToScreen(transform, { x: 0, y: 1000 });
    expect(bottom.y).toBeGreaterThan(transform.y);
    const local = interiorScreenToLocal(transform, interiorLocalToScreen(transform, { x: 321, y: 654 }));
    expect(local.x).toBeCloseTo(321, 9);
    expect(local.y).toBeCloseTo(654, 9);
  });

  it("y-sorts room actors with players and mobs and picks objects in local space", () => {
    const actorParent = new Container();
    const layer = new InteriorRoomLayer({
      actorParent,
      loadTexture: vi.fn(async () => Texture.EMPTY),
      unloadTexture: vi.fn()
    });
    layer.update(interiorState([object("north", 500, 200), object("south", 500, 800)]));
    const player = new Container();
    actorParent.addChild(player);
    const project = fakeProject(1_000_000);
    const transform = interiorRoomTransform(project, { roomWidth: 1000, metersPerUnit });
    player.position.copyFrom(interiorLocalToScreen(transform, { x: 500, y: 500 }));
    layer.frame(project);

    const item = (id: string) => actorParent.children.find((child) => child.label === `interior-item:object:${id}`)!;
    expect(actorParent.sortableChildren).toBe(true);
    expect(item("north").zIndex).toBeLessThan(player.zIndex);
    expect(item("south").zIndex).toBeGreaterThan(player.zIndex);
    expect(item("south").position.y).toBeCloseTo(interiorLocalToScreen(transform, { x: 500, y: 800 }).y, 6);

    const southScreen = interiorLocalToScreen(transform, { x: 510, y: 790 });
    expect(layer.pickObjectAt(southScreen)?.id).toBe("south");
    expect(layer.pickObjectAt(interiorLocalToScreen(transform, { x: 900, y: 900 }))).toBeNull();
    const paddedScreen = interiorLocalToScreen(transform, { x: 500, y: 500 });
    expect(layer.pickObjectsAt(paddedScreen).map((hit) => hit.object.id)).toEqual([]);
    expect(layer.pickObjectsAt(paddedScreen, 4_000).map((hit) => hit.object.id).sort()).toEqual(["north", "south"]);

    layer.update(null);
    expect(actorParent.sortableChildren).toBe(false);
    expect(actorParent.children).toEqual([player]);
  });
});

describe("interior room layer texture lifetime", () => {
  const prefab = (id: string) => ({
    id, assetKey: `apps/client/public/assets/${id}.png`, renderMode: "sprite",
    defaultWidth: 64, defaultHeight: 64, pivotX: 0.5, pivotY: 0.5
  });
  const placement = (id: string, prefabId: string) => ({
    id, prefabId, x: 0, y: 0, width: 64, height: 64, rotationDeg: 0, flipX: false,
    flipY: false, opacity: 1, zIndex: 0, retired: false
  });
  const room = (spaceKey: string, prefabIds: string[]) => ({
    ...interiorState([]),
    spaceKey,
    prefabs: prefabIds.map(prefab),
    layers: {
      background: prefabIds.map((id) => placement(`p-${id}`, id)),
      below_player: [], actors: [], above_player: [], ceiling: []
    }
  }) as unknown as InteriorRenderState;
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("keeps shared floor textures across room changes and unloads after sprites are destroyed on leaving", async () => {
    const actorParent = new Container();
    const events: string[] = [];
    const loadTexture = vi.fn(async () => Texture.EMPTY);
    const layer = new InteriorRoomLayer({
      actorParent,
      loadTexture,
      unloadTexture: vi.fn((url: string) => {
        events.push(`unload:${url}:sprites=${layer.below.children.length}`);
      })
    });
    const floor = `${import.meta.env.BASE_URL}assets/floor.png`;
    layer.update(room("dungeon:a:a", ["floor", "door"]));
    await flush();
    expect(layer.below.children.length).toBe(2);
    layer.update(room("dungeon:a:b", ["floor"]));
    await flush();
    layer.update(room("dungeon:a:a", ["floor", "door"]));
    await flush();
    expect(events).toEqual([]);
    expect(loadTexture).toHaveBeenCalledTimes(2);
    expect(layer.below.children.length).toBe(2);

    layer.update(null);
    await flush();
    expect(events).toHaveLength(2);
    expect(events).toContain(`unload:${floor}:sprites=0`);
    expect(layer.below.children.length).toBe(0);
  });

  it("waits for a pending unload before reloading the same url and skips shared urls", async () => {
    const order: string[] = [];
    let finishUnload: () => void = () => undefined;
    const layer = new InteriorRoomLayer({
      actorParent: new Container(),
      loadTexture: vi.fn(async (url: string) => {
        order.push(`load:${url.split("/").pop()}`);
        return Texture.EMPTY;
      }),
      unloadTexture: (url: string) => new Promise<void>((resolve) => {
        order.push(`unload:${url.split("/").pop()}`);
        finishUnload = resolve;
      }),
      isTextureShared: (url: string) => url.endsWith("shared.png")
    });
    layer.update(room("dungeon:a:a", ["floor", "shared"]));
    await flush();
    layer.update(null);
    await flush();
    layer.update(room("dungeon:a:a", ["floor"]));
    await flush();
    expect(order).toEqual(["load:floor.png", "load:shared.png", "unload:floor.png"]);
    finishUnload();
    await flush();
    expect(order.at(-1)).toBe("load:floor.png");
  });
});
