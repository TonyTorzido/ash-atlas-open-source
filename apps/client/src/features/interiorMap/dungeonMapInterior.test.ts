import { describe, expect, it } from "vitest";

import { DUNGEON_ELITE_TUNING, isIndoorNavigationPointWalkable } from "@ash-atlas/shared";

import {
  buildDungeonInteriorRenderState, createDungeonInteriorCollectibles, dungeonLocalToMapLngLat, dungeonMapWalkTarget,
  HEART_PUZZLE_PELL_ASSET_KEY, heartPuzzleRoomNavigation, heartPuzzleRoomObjects
} from "./dungeonMapInterior.js";
import {
  dungeonEliteMapLabel,
  dungeonElitesByEntityId,
  dungeonEnemyVisualScale,
  withDungeonEliteName
} from "./dungeonElitePresentation.js";

const resource = (over: Record<string, unknown> = {}) => ({
  id: "ore-1", roomId: "room", resourceType: "stone", x: 300, y: 200, quantity: 4,
  state: "available", availableAt: null, interactionRadius: 72, source: "authored", ...over
}) as never;

describe("dungeon interior collectibles", () => {
  it("projects resource nodes as overworld collectibles with stable identity across snapshots", () => {
    const build = createDungeonInteriorCollectibles();
    const first = build({ resources: [resource(), resource({ id: "tree-1", resourceType: "wood" })] });
    expect(first.map((node) => node.id)).toEqual(["dungeon-resource:ore-1", "dungeon-resource:tree-1"]);
    expect(first[0]).toMatchObject({ repeatableNodeType: "stone_mine", repeatableState: "ready" });

    const again = build({ resources: [resource(), resource({ id: "tree-1", resourceType: "wood" })] });
    expect(again).toBe(first);
    expect(again[0]).toBe(first[0]);
  });

  it("changes only the node whose state changed and drops harvested trees", () => {
    const build = createDungeonInteriorCollectibles();
    const tree = resource({ id: "tree-1", resourceType: "wood" });
    const first = build({ resources: [resource(), tree] });
    const next = build({
      resources: [resource({ state: "depleted", quantity: 0, availableAt: null }), resource({ id: "tree-1", resourceType: "wood", state: "depleted", quantity: 0 })]
    });
    expect(next).toHaveLength(1);
    expect(next[0]).not.toBe(first[0]);
    expect(next[0]).toMatchObject({ repeatableState: "depleted", repeatableTimerVisibility: "redacted" });
    expect(build(null)).toEqual([]);
  });
});

describe("map-rendered dungeon elites", () => {
  it("scales, labels and names an elite the way the old room layer did", () => {
    const elite = { modifiers: ["swift", "shielded"], shieldActive: true };
    expect(dungeonEnemyVisualScale({ visualScale: 2, elite })).toBeCloseTo(2 * DUNGEON_ELITE_TUNING.visualScaleMultiplier);
    expect(dungeonEnemyVisualScale({ visualScale: 2 })).toBe(2);
    expect(dungeonEliteMapLabel(elite, "Cave Raptor").split("\n")).toEqual(["Elite Cave Raptor", "Swift · Shield"]);
    const elites = dungeonElitesByEntityId([{ entityId: "mob-1", elite }, { entityId: "mob-2" }]);
    const mob = (entityId: string) => ({ entityId, kind: "mob", name: "Cave Raptor" }) as never;
    const named = withDungeonEliteName(mob("mob-1"), elites) as { name: string };
    expect(named.name).toBe("Elite Cave Raptor");
    expect(withDungeonEliteName(named as never, elites)).toBe(named);
    const plain = mob("mob-2");
    expect(withDungeonEliteName(plain, elites)).toBe(plain);
  });

  it("hands the overlay elite-named entities, so its target picks read Elite <name>", () => {
    const player = { playerId: "p1", name: "P", displayColor: "#fff", x: 10, y: 10, targetX: null, targetY: null, movementRevision: 1 };
    const snapshot = {
      instanceId: "i", spaceId: "room", dungeonId: "fangrock_cavern", roomWidth: 100, roomHeight: 100,
      room: { layers: [] }, prefabs: [], objects: [], portalLocks: {}, player, occupants: [],
      enemies: [{ entityId: "mob-1", visualScale: 1, elite: { modifiers: ["swift"] } }, { entityId: "mob-2", visualScale: 1 }]
    } as never;
    const mob = (entityId: string) => ({ entityId, kind: "mob", name: "Cave Raptor" }) as never;
    const plain = mob("mob-2");
    const state = buildDungeonInteriorRenderState({
      snapshot, localPlayer: null, combatEntities: [mob("mob-1"), plain], selectedObjectId: null
    });
    expect(state.combatEntities.map((entity) => entity.name)).toEqual(["Elite Cave Raptor", "Cave Raptor"]);
    expect(state.combatEntities[1]).toBe(plain);
    expect(state.mobVisualScales?.get("mob-1")).toBeCloseTo(DUNGEON_ELITE_TUNING.visualScaleMultiplier);
  });
});

describe("Ash Heart puzzle rooms", () => {
  const object = (id: string, kind: string, over: Record<string, unknown> = {}) => ({ id, kind, opacity: 1, ...over }) as never;
  const room = {
    dungeonId: "tilted_vault", spaceId: "vault_r1", roomWidth: 1080, roomHeight: 1510,
    player: { x: 540, y: 1380 },
    objects: [object("vault_pell_1", "npc"), object("vault_seal_1", "switch"), object("vault_r1_to_combat_a_object", "portal"), object("chest-1", "chest")]
  } as never;

  it("hides the baked doors and the seal sprite, keeps their objects, and dresses Pell", () => {
    const objects = heartPuzzleRoomObjects(room) as unknown as Array<{ id: string; opacity: number; assetKey?: string }>;
    expect(objects.map((o) => o.id)).toEqual(["vault_pell_1", "vault_seal_1", "vault_r1_to_combat_a_object", "chest-1"]);
    expect(objects.map((o) => o.opacity)).toEqual([1, 0, 0, 1]);
    expect(objects[0]!.assetKey).toBe(HEART_PUZZLE_PELL_ASSET_KEY);
    expect(heartPuzzleRoomObjects({ ...(room as object), dungeonId: "cistern_warrens" } as never)).toBe((room as { objects: unknown }).objects);
  });

  it("keeps stick and double-tap targets on the painted floor", () => {
    const nav = heartPuzzleRoomNavigation(room)!;
    expect(nav).not.toBeNull();
    // Toward the back facade across the unsolved board: the whole board is solid, so the walk stops at its foot.
    const board = dungeonMapWalkTarget(room, dungeonLocalToMapLngLat({ x: 540, y: 20 }), null)!;
    expect(isIndoorNavigationPointWalkable(nav, board)).toBe(true);
    expect(board.y).toBeGreaterThan(1340);
    expect(board.y).toBeLessThan(1380);
    // Once the seal is open the board is floor: the same walk crosses it, stopping on the floor, still heading up.
    const solved = { ...(room as object), objects: [object("vault_seal_1", "switch", { state: "on" })] } as never;
    const wall = dungeonMapWalkTarget(solved, dungeonLocalToMapLngLat({ x: 540, y: 20 }), null)!;
    expect(isIndoorNavigationPointWalkable(nav, wall)).toBe(true);
    expect(wall.y).toBeLessThan(1300);
    // Straight into the left wall from against it: no move.
    expect(dungeonMapWalkTarget({ ...(room as object), player: { x: 82, y: 700 } } as never, dungeonLocalToMapLngLat({ x: 0, y: 700 }), null)).toBeNull();
    // A plain dungeon room keeps the room-clamped target.
    expect(heartPuzzleRoomNavigation({ dungeonId: "cistern_warrens", spaceId: "hatch_landing" })).toBeNull();
  });
});
