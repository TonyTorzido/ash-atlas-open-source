import {
  wgs84DestinationPoint,
  type CitySnapshot,
  type CityStructureSnapshot,
  type CollectibleNode,
  type CombatEntitySnapshot,
  type DroppedItemSnapshot,
  type DungeonEntranceSnapshot,
  type DungeonObjectSnapshot,
  type FlagSnapshot,
  type FurnaceWorldSnapshot,
  type GreenhouseSnapshot,
  type ManorWorldSnapshot,
  type PlayerSnapshot
} from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import type { WorldObjectPick } from "./worldObjectPickContracts.js";
import {
  preferCityStructuresOverTheirCity,
  injuredCombatEntityHealthPercent,
  orderRepeatedWorldObjectsNearestToPlayer,
  prioritizeWorldObjectPicks,
  worldObjectPickDistanceMeta,
  type WorldObjectPickCandidate
} from "./worldObjectPickPriority.js";

describe("world object pick priority", () => {
  it("removes a parent city when its structure is hit", () => {
    const city = { id: "city-1" } as CitySnapshot;
    const oilWell = {
      structureId: "well-1",
      cityId: city.id,
      type: "oil_well"
    } as CityStructureSnapshot;
    const picks: WorldObjectPick[] = [
      { kind: "city", value: city },
      { kind: "city_structure", value: oilWell }
    ];

    expect(preferCityStructuresOverTheirCity(picks)).toEqual([
      { kind: "city_structure", value: oilWell }
    ]);
  });

  it("orders categories, then distance, then deterministic key", () => {
    const candidates: WorldObjectPickCandidate[] = [
      candidate("collectible:near", "collectible", { id: "near" } as CollectibleNode, 1),
      candidate("player:near", "player", { playerId: "near" } as PlayerSnapshot, 1),
      candidate("dropped_item:wood", "dropped_item", {
        dropId: "wood"
      } as DroppedItemSnapshot, 30),
      candidate("combat_entity:b", "combat_entity", { entityId: "b" } as CombatEntitySnapshot, 8),
      candidate("flag:far", "flag", { id: "far" } as FlagSnapshot, 20),
      candidate("dungeon_entrance:orc", "dungeon_entrance", {
        entranceId: "orc"
      } as DungeonEntranceSnapshot, 3),
      candidate("manor:near", "manor", { manorId: "near" } as ManorWorldSnapshot, 4),
      candidate("greenhouse:near", "greenhouse", { greenhouseId: "near" } as GreenhouseSnapshot, 5),
      candidate("combat_entity:a", "combat_entity", { entityId: "a" } as CombatEntitySnapshot, 8),
      candidate("flag:near", "flag", { id: "near" } as FlagSnapshot, 2)
    ];

    expect(prioritizeWorldObjectPicks(candidates).map(pickKey)).toEqual([
      "flag:near",
      "dungeon_entrance:orc",
      "manor:near",
      "greenhouse:near",
      "flag:far",
      "dropped_item:wood",
      "combat_entity:a",
      "combat_entity:b",
      "player:near",
      "collectible:near"
    ]);
  });

  it("prioritizes a city center over a nearer flag", () => {
    const city = { id: "city-1" } as CitySnapshot;
    const flag = { id: "flag-1" } as FlagSnapshot;

    expect(prioritizeWorldObjectPicks([
      candidate("flag:flag-1", "flag", flag, 1),
      candidate("city:city-1", "city", city, 20)
    ])).toEqual([
      { kind: "city", value: city },
      { kind: "flag", value: flag }
    ]);
  });

  it("suppresses a parent city before sorting", () => {
    const city = { id: "city-1" } as CitySnapshot;
    const structure = {
      structureId: "structure-1",
      cityId: city.id
    } as CityStructureSnapshot;

    expect(prioritizeWorldObjectPicks([
      candidate("city:city-1", "city", city, 1),
      candidate("city_structure:structure-1", "city_structure", structure, 10)
    ])).toEqual([{ kind: "city_structure", value: structure }]);
  });

  it("orders each repeated mob identity nearest-first without moving other identities", () => {
    const player = { lat: 35, lon: -106 };
    const wolfFar = combatPick("wolf-far", "wolf", "Wolf", 35.003);
    const bearFar = combatPick("bear-far", "bear", "Bear", 35.004);
    const wolfMid = combatPick("wolf-mid", "wolf", "Wolf", 35.002);
    const bearNear = combatPick("bear-near", "bear", "Bear", 35.001);
    const wolfNear = combatPick("wolf-near", "wolf", "Wolf", 35.0005);
    const picks: WorldObjectPick[] = [wolfFar, bearFar, wolfMid, bearNear, wolfNear];

    expect(orderRepeatedWorldObjectsNearestToPlayer(picks, player).map(pickKey)).toEqual([
      "combat_entity:wolf-near",
      "combat_entity:bear-near",
      "combat_entity:wolf-mid",
      "combat_entity:bear-far",
      "combat_entity:wolf-far"
    ]);
  });

  it("uses stable names when an archetype key is unavailable", () => {
    const player = { lat: 35, lon: -106 };
    const far = combatPick("far", null, "Cave Crawler", 35.002);
    const near = combatPick("near", null, "Cave Crawler", 35.001);
    const other = combatPick("other", null, "Bog Crawler", 35.0001);

    expect(orderRepeatedWorldObjectsNearestToPlayer([far, other, near], player).map(pickKey))
      .toEqual(["combat_entity:near", "combat_entity:other", "combat_entity:far"]);
  });

  it("orders repeated presented resources and item variants without moving other identities", () => {
    const player = { lat: 35, lon: -106 };
    const givingFar = collectiblePick("tree-0", "wood", 35.004);
    const rubyFar = droppedItemPick("ruby-far", "enchantment_stone", "ruby", 35.006);
    const willowNear = collectiblePick("tree-200", "wood", 35.0001);
    const emeraldNear = droppedItemPick("emerald", "enchantment_stone", "emerald", 35.0002);
    const givingNear = collectiblePick("tree-1", "wood", 35.001);
    const rubyNear = droppedItemPick("ruby-near", "enchantment_stone", "ruby", 35.002);

    expect(orderRepeatedWorldObjectsNearestToPlayer([
      givingFar,
      rubyFar,
      willowNear,
      emeraldNear,
      givingNear,
      rubyNear
    ], player).map(pickKey)).toEqual([
      "collectible:tree-1",
      "dropped_item:ruby-near",
      "collectible:tree-200",
      "dropped_item:emerald",
      "collectible:tree-0",
      "dropped_item:ruby-far"
    ]);
  });

  it("orders generic repeated structures while leaving individually named entities in place", () => {
    const player = { lat: 35, lon: -106 };
    const furnaceFar = furnacePick("furnace-far", 35.004);
    const firstCity = { id: "city-first", name: "Twin City", lat: 35.003, lon: -106 } as CitySnapshot;
    const furnaceNear = furnacePick("furnace-near", 35.001);
    const secondCity = { id: "city-second", name: "Twin City", lat: 35.0001, lon: -106 } as CitySnapshot;

    expect(orderRepeatedWorldObjectsNearestToPlayer([
      furnaceFar,
      { kind: "city", value: firstCity },
      furnaceNear,
      { kind: "city", value: secondCity }
    ], player).map(pickKey)).toEqual([
      "furnace:furnace-near",
      "city:city-first",
      "furnace:furnace-far",
      "city:city-second"
    ]);
  });

  it("retains original order when repeated targets are equally distant", () => {
    const player = { lat: 35, lon: -106 };
    const first = collectiblePick("tree-0", "wood", 35.001);
    const second = collectiblePick("tree-1", "wood", 35.001);

    expect(orderRepeatedWorldObjectsNearestToPlayer([first, second], player).map(pickKey))
      .toEqual(["collectible:tree-0", "collectible:tree-1"]);
  });

  it("formats compact rounded distance and injured combat health", () => {
    const player = { lat: 35, lon: -106 };
    const target = wgs84DestinationPoint(player, 30, 90);
    expect(worldObjectPickDistanceMeta(
      player,
      { kind: "combat_entity", value: {
        entityId: "wolf",
        name: "Wolf",
        archetypeKey: "wolf",
        currentHealth: 45,
        maxHealth: 100,
        ...target
      } as CombatEntitySnapshot }
    )).toBe("30m 45%");
  });

  it("omits full, non-combat, and invalid health and never rounds injured health to 100", () => {
    const base = {
      entityId: "wolf",
      name: "Wolf",
      archetypeKey: "wolf",
      lat: 35,
      lon: -106
    } as CombatEntitySnapshot;

    expect(injuredCombatEntityHealthPercent({
      ...base,
      currentHealth: 999.6,
      maxHealth: 1_000
    })).toBe(99);
    expect(injuredCombatEntityHealthPercent({
      ...base,
      currentHealth: 1_000,
      maxHealth: 1_000
    })).toBeNull();
    expect(injuredCombatEntityHealthPercent({
      ...base,
      currentHealth: 5,
      maxHealth: 0
    })).toBeNull();
    expect(worldObjectPickDistanceMeta(
      base,
      { kind: "collectible", value: {
        id: "tree",
        lat: 35,
        lon: -106,
        currentHealth: 1,
        maxHealth: 10
      } as unknown as CollectibleNode }
    )).toBe("0m");
  });

  it("orders interior picks after creatures and drops, dungeon resource nodes before fixtures", () => {
    const object = { id: "lever", x: 100, y: 100 } as DungeonObjectSnapshot;
    const resource = { id: "dungeon-resource:ore", lat: 0, lon: 0 } as CollectibleNode;
    const enemy = { entityId: "rat" } as CombatEntitySnapshot;
    const picks = prioritizeWorldObjectPicks([
      candidate("interior_object:lever", "interior_object", object, 1),
      candidate("collectible:dungeon-resource:ore", "collectible", resource, 50),
      candidate("combat_entity:rat", "combat_entity", enemy, 90)
    ]);
    expect(picks.map(pickKey)).toEqual([
      "combat_entity:rat",
      "collectible:dungeon-resource:ore",
      "interior_object:lever"
    ]);
  });

  it("puts a dungeon door ahead of the awake mobs and players over it, other fixtures stay behind them", () => {
    const door = { id: "combat_a_back", kind: "portal", x: 100, y: 100 } as DungeonObjectSnapshot;
    const lever = { id: "lever", kind: "fixture", x: 100, y: 100 } as unknown as DungeonObjectSnapshot;
    const enemy = { entityId: "warden" } as CombatEntitySnapshot;
    const picks = prioritizeWorldObjectPicks([
      candidate("combat_entity:warden", "combat_entity", enemy, 1),
      candidate("interior_object:lever", "interior_object", lever, 2),
      candidate("interior_object:combat_a_back", "interior_object", door, 60)
    ]);
    expect(picks.map(pickKey)).toEqual([
      "interior_object:combat_a_back",
      "combat_entity:warden",
      "interior_object:lever"
    ]);
  });

  it("measures interior pick distance from the map player position", () => {
    const player = { lat: 0, lon: 0 };
    const near = { kind: "interior_object", value: { id: "a", x: 0, y: 0 } as DungeonObjectSnapshot } as const;
    const far = { kind: "interior_object", value: { id: "b", x: 1300, y: 0 } as DungeonObjectSnapshot } as const;
    expect(worldObjectPickDistanceMeta(player, near)).toBe("0m");
    expect(worldObjectPickDistanceMeta(player, far)).not.toBe("0m");
    expect(orderRepeatedWorldObjectsNearestToPlayer([far, near], player)).toEqual([far, near]);
  });
});

function combatPick(
  entityId: string,
  archetypeKey: string | null,
  name: string,
  lat: number
): Extract<WorldObjectPick, { kind: "combat_entity" }> {
  return {
    kind: "combat_entity",
    value: { entityId, archetypeKey, name, lat, lon: -106 } as CombatEntitySnapshot
  };
}

function collectiblePick(
  id: string,
  type: CollectibleNode["type"],
  lat: number
): Extract<WorldObjectPick, { kind: "collectible" }> {
  return {
    kind: "collectible",
    value: { id, type, lat, lon: -106 } as CollectibleNode
  };
}

function droppedItemPick(
  dropId: string,
  itemId: DroppedItemSnapshot["itemId"],
  variant: string | null,
  lat: number
): Extract<WorldObjectPick, { kind: "dropped_item" }> {
  return {
    kind: "dropped_item",
    value: { dropId, itemId, variant, lat, lon: -106 } as DroppedItemSnapshot
  };
}

function furnacePick(
  furnaceId: string,
  lat: number
): Extract<WorldObjectPick, { kind: "furnace" }> {
  return {
    kind: "furnace",
    value: { furnaceId, lat, lon: -106 } as FurnaceWorldSnapshot
  };
}

function candidate<Kind extends WorldObjectPick["kind"]>(
  key: string,
  kind: Kind,
  value: Extract<WorldObjectPick, { kind: Kind }>["value"],
  distancePx: number
): WorldObjectPickCandidate {
  return { key, distancePx, pick: { kind, value } as WorldObjectPick };
}

function pickKey(pick: WorldObjectPick): string {
  switch (pick.kind) {
    case "flag": return `flag:${pick.value.id}`;
    case "city": return `city:${pick.value.id}`;
    case "city_structure": return `city_structure:${pick.value.structureId}`;
    case "dungeon_entrance": return `dungeon_entrance:${pick.value.entranceId}`;
    case "manor": return `manor:${pick.value.manorId}`;
    case "greenhouse": return `greenhouse:${pick.value.greenhouseId}`;
    case "furnace": return `furnace:${pick.value.furnaceId}`;
    case "tannery": return `tannery:${pick.value.tanneryId}`;
    case "loom": return `loom:${pick.value.loomId}`;
    case "kitchen": return `kitchen:${pick.value.kitchenId}`;
    case "fishing_hut": return `fishing_hut:${pick.value.fishingHutId}`;
    case "collectible": return `collectible:${pick.value.id}`;
    case "dropped_item": return `dropped_item:${pick.value.dropId}`;
    case "player": return `player:${pick.value.playerId}`;
    case "combat_entity": return `combat_entity:${pick.value.entityId}`;
    case "interior_object": return `interior_object:${pick.value.id}`;
  }
}
