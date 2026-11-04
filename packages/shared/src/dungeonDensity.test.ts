import { describe, expect, it } from "vitest";

import { cisternWarrensRoomNavigation } from "./dungeon.js";
import {
  DUNGEON_CATALOG,
  dungeonCatalogValidationIssues,
  type DungeonDefinition,
  type DungeonRewardTableDefinition,
  type DungeonRoomDefinition
} from "./dungeonCatalog.js";
import { dungeonObjectSpawnsInRun, dungeonSpawnGroupSelection, resolveDungeonChestLoot, resolveDungeonChestRarity } from "./dungeonRolls.js";
import { isIndoorNavigationPointWalkable } from "./indoor.js";
import { INVENTORY_CATALOG } from "./inventoryCatalog.js";

const CLASSIC_DUNGEON_IDS = ["cistern_warrens", "fangrock_cavern", "the_eyrie", "blightwood_grove"] as const;
const DOORWAY_CLEARANCE = 200;
const MOB_CLEARANCE = 50;
const CHEST_CLEARANCE = 60;

const dungeonOf = (id: string): DungeonDefinition => DUNGEON_CATALOG.dungeons.find((dungeon) => dungeon.id === id)!;
const tableOf = (id: string): DungeonRewardTableDefinition => DUNGEON_CATALOG.rewardTables.find((table) => table.id === id)!;
const activeRooms = (dungeon: DungeonDefinition) => dungeon.rooms.filter((room) => !room.retired && room.active);
const anchorOf = (room: DungeonRoomDefinition, id: string) => room.anchors.find((anchor) => anchor.id === id)!;
const doorways = (room: DungeonRoomDefinition) => room.anchors.filter((anchor) =>
  !anchor.retired && /^(door_|world_exit$|exit_ladder$)/.test(anchor.id));
const smallChests = (dungeon: DungeonDefinition) => dungeon.rooms.flatMap((room) =>
  room.objects.filter((object) => !object.retired && object.spawnGroup).map((object) => ({ room, object })));

function rectangleDistance(
  rectangle: { x: number; y: number; width: number; height: number },
  point: { x: number; y: number }
): number {
  const dx = Math.max(rectangle.x - point.x, 0, point.x - (rectangle.x + rectangle.width));
  const dy = Math.max(rectangle.y - point.y, 0, point.y - (rectangle.y + rectangle.height));
  return Math.hypot(dx, dy);
}

describe("dungeon density content", () => {
  it("keeps the whole catalog valid", () => {
    expect(dungeonCatalogValidationIssues(DUNGEON_CATALOG)).toEqual([]);
  });

  it("themes resource zones per dungeon and keeps them walkable, off doorways, and off mob spawns", () => {
    const themes: Record<string, readonly string[]> = {
      cistern_warrens: ["coal", "iron", "ore", "sulfur"],
      fangrock_cavern: ["ore", "stone", "coal", "iron"],
      the_eyrie: ["stone", "wood", "flax_fiber"],
      blightwood_grove: ["wood", "balsam_resin", "flax_fiber"]
    };
    const problems: string[] = [];
    for (const id of CLASSIC_DUNGEON_IDS) {
      const dungeon = dungeonOf(id);
      const roomsWithZones = new Set<string>();
      const types = new Set<string>();
      for (const room of activeRooms(dungeon)) {
        const navigation = cisternWarrensRoomNavigation(room.id, dungeon);
        for (const zone of room.resourceSpawnZones ?? []) {
          if (zone.retired) continue;
          roomsWithZones.add(room.id);
          zone.resourceTypes.forEach((type) => types.add(type));
          expect(zone.shape.kind, `${id}/${room.id}/${zone.id}`).toBe("rectangle");
          if (zone.shape.kind !== "rectangle") continue;
          const shape = zone.shape;
          expect(zone.maxCount, `${zone.id} stays modest`).toBeLessThanOrEqual(3);
          const blocked: string[] = [];
          for (let x = shape.x; x <= shape.x + shape.width; x += 10) {
            for (let y = shape.y; y <= shape.y + shape.height; y += 10) {
              if (!isIndoorNavigationPointWalkable(navigation, { x, y })) blocked.push(`${x},${y}`);
            }
          }
          if (blocked.length > 0) problems.push(`${id}/${room.id}/${zone.id} unwalkable at ${blocked.slice(0, 3).join(" ")}`);
          for (const doorway of doorways(room)) {
            if (rectangleDistance(shape, doorway) < DOORWAY_CLEARANCE) problems.push(`${zone.id} too close to ${doorway.id}`);
          }
          for (const mob of room.mobs.filter((candidate) => !candidate.retired)) {
            if (rectangleDistance(shape, anchorOf(room, mob.anchorId)) < MOB_CLEARANCE) problems.push(`${zone.id} too close to ${mob.id}`);
          }
          for (const { room: chestRoom, object } of smallChests(dungeon)) {
            if (chestRoom.id !== room.id) continue;
            if (rectangleDistance(shape, anchorOf(room, object.anchorId)) < CHEST_CLEARANCE) problems.push(`${zone.id} too close to ${object.id}`);
          }
        }
      }
      expect(roomsWithZones.size, `${id} dense rooms`).toBeGreaterThanOrEqual(4);
      for (const type of types) expect(themes[id], `${id} theme ${type}`).toContain(type);
      for (const type of themes[id]!) expect(types.has(type), `${id} offers ${type}`).toBe(true);
    }
    expect(problems).toEqual([]);
  });

  it("authors small-chest candidates on walkable side spots, away from doorways and mobs", () => {
    for (const id of CLASSIC_DUNGEON_IDS) {
      const dungeon = dungeonOf(id);
      const chests = smallChests(dungeon);
      expect(chests.length, id).toBeGreaterThanOrEqual(5);
      const group = chests[0]!.object.spawnGroup!;
      expect(group).toMatchObject({ min: 1, max: 3 });
      for (const { room, object } of chests) {
        const anchor = anchorOf(room, object.anchorId);
        expect(object.spawnGroup).toEqual(group);
        expect(object).toMatchObject({ type: "chest", prefabId: "dungeon_baby_chest", available: true, initialState: "closed" });
        expect(isIndoorNavigationPointWalkable(cisternWarrensRoomNavigation(room.id, dungeon), anchor), object.id).toBe(true);
        for (const doorway of doorways(room)) {
          expect(Math.hypot(anchor.x - doorway.x, anchor.y - doorway.y), `${object.id} vs ${doorway.id}`).toBeGreaterThanOrEqual(DOORWAY_CLEARANCE);
        }
        for (const mob of room.mobs.filter((candidate) => !candidate.retired)) {
          const spawn = anchorOf(room, mob.anchorId);
          expect(Math.hypot(anchor.x - spawn.x, anchor.y - spawn.y), `${object.id} vs ${mob.id}`).toBeGreaterThanOrEqual(MOB_CLEARANCE);
        }
        const trigger = dungeon.triggers.find((candidate) => candidate.event.type === "object_interact" &&
          candidate.event.objectId === object.id);
        expect(trigger, `${object.id} reward trigger`).toMatchObject({ scope: "player", repetition: "once",
          actions: [{ type: "grant_reward", rewardTableId: object.rewardTableId }] });
      }
    }
    const baby = DUNGEON_CATALOG.prefabs.find((prefab) => prefab.id === "dungeon_baby_chest")!;
    const big = DUNGEON_CATALOG.prefabs.find((prefab) => prefab.id === "dungeon_chest")!;
    expect(baby.assetKey).toBe(big.assetKey);
    expect(baby.defaultWidth).toBeLessThan(big.defaultWidth);
  });

  it("picks 1-3 small chests per run, deterministically, varying across runs", () => {
    for (const id of CLASSIC_DUNGEON_IDS) {
      const dungeon = dungeonOf(id);
      const [first] = smallChests(dungeon);
      const groupId = first!.object.spawnGroup!.id;
      const sizes = new Set<number>();
      const picks = new Set<string>();
      const appearances = new Map<string, number>();
      for (let run = 0; run < 400; run += 1) {
        const runId = `run-${id}-${run}`;
        const selection = dungeonSpawnGroupSelection(dungeon, runId, groupId);
        expect(selection.size).toBeGreaterThanOrEqual(1);
        expect(selection.size).toBeLessThanOrEqual(3);
        expect([...dungeonSpawnGroupSelection(dungeon, runId, groupId)]).toEqual([...selection]);
        sizes.add(selection.size);
        picks.add([...selection].sort().join("|"));
        selection.forEach((key) => appearances.set(key, (appearances.get(key) ?? 0) + 1));
        // The per-object gate agrees with the group's pick.
        const present = smallChests(dungeon).filter(({ room, object }) =>
          dungeonObjectSpawnsInRun(dungeon, runId, room.id, object)).length;
        expect(present).toBe(selection.size);
      }
      expect([...sizes].sort()).toEqual([1, 2, 3]);
      expect(picks.size).toBeGreaterThan(10);
      // Every authored spot is reachable by some run.
      expect(appearances.size).toBe(smallChests(dungeon).length);
    }
  });

  it("keeps fixed objects present and ignores spawn groups for them", () => {
    const sewer = dungeonOf("cistern_warrens");
    const alcove = sewer.rooms.find((room) => room.id === "turtle_cistern")!.objects.find((object) => object.id === "alcove-chest")!;
    expect(dungeonObjectSpawnsInRun(sewer, "any-run", "turtle_cistern", alcove)).toBe(true);
    expect(dungeonSpawnGroupSelection(sewer, "any-run", "no-such-group").size).toBe(0);
  });

  it("rejects malformed spawn groups", () => {
    const catalog = structuredClone(DUNGEON_CATALOG);
    const sewer = catalog.dungeons.find((dungeon) => dungeon.id === "cistern_warrens")!;
    const chests = sewer.rooms.flatMap((room) => room.objects.filter((object) => object.spawnGroup));
    chests[0]!.spawnGroup = { ...chests[0]!.spawnGroup!, max: 2 };
    chests[1]!.spawnChance = 50;
    const messages = dungeonCatalogValidationIssues(catalog).map((issue) => issue.message);
    expect(messages).toContain("every object in a spawn group must repeat the same min and max");
    expect(messages).toContain("spawn groups replace spawnChance");
  });
});

describe("dungeon chest tables", () => {
  const babyIds = ["cistern_warrens_baby_chest", "fangrock_cavern_baby_chest", "the_eyrie_baby_chest", "blightwood_grove_baby_chest"];
  const bossIds = ["cistern_warrens_brood_chest_reward", "fangrock_cavern_throne_chest_reward", "the_eyrie_crown_chest_reward", "blightwood_grove_heart_chest_reward"];

  it("lists every chest table on its dungeon and only grants real items", () => {
    for (const id of CLASSIC_DUNGEON_IDS) {
      const dungeon = dungeonOf(id);
      const used = new Set(dungeon.rooms.flatMap((room) => room.objects).map((object) => object.rewardTableId).filter(Boolean));
      for (const tableId of used) {
        expect(dungeon.rewardTableIds, `${id} lists ${tableId}`).toContain(tableId);
        expect(tableOf(tableId!).retired).toBe(false);
      }
    }
    for (const tableId of [...babyIds, ...bossIds, "cistern_warrens_alcove_chest_reward", "fangrock_cavern_den_chest_reward"]) {
      const table = tableOf(tableId);
      expect(table.chestLoot, tableId).toBeDefined();
      for (const row of table.chestLoot!.rarities) {
        for (const loot of row.loot) expect(INVENTORY_CATALOG[loot.itemId]?.packageGrantable, `${tableId}/${loot.itemId}`).toBe(true);
      }
    }
  });

  it("makes baby chests mostly common, occasionally uncommon, and level-scaled", () => {
    const gold = babyIds.map((id) => tableOf(id).gold!);
    expect([...gold].sort((a, b) => a - b)).toEqual(gold);
    for (const id of babyIds) {
      const table = tableOf(id);
      const chances = Object.fromEntries(table.chestLoot!.rarities.map((row) => [row.rarity, row.chance]));
      expect(chances).toMatchObject({ common: 83, uncommon: 17, rare: 0, epic: 0, legendary: 0 });
      const counts = { common: 0, uncommon: 0 } as Record<string, number>;
      for (let roll = 0; roll < 2_000; roll += 1) {
        const rarity = resolveDungeonChestRarity(table, `seed-${id}-${roll}`)!;
        counts[rarity] = (counts[rarity] ?? 0) + 1;
      }
      expect(counts.common).toBeGreaterThan(counts.uncommon!);
      expect(Object.keys(counts).sort()).toEqual(["common", "uncommon"]);
      const loot = resolveDungeonChestLoot(table, `loot-${id}`);
      expect(loot.items.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("pays boss chests better than baby chests, with the sewer lowest", () => {
    const golds = bossIds.map((id) => tableOf(id).gold!);
    expect([...golds].sort((a, b) => a - b)).toEqual(golds);
    babyIds.forEach((babyId, index) => expect(tableOf(bossIds[index]!).gold!).toBeGreaterThan(tableOf(babyId).gold! * 4));
    expect(golds[0]).toBeLessThan(golds[1]!);
  });
});
