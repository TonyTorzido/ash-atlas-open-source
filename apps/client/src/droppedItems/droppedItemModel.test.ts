import {
  MANOR_DROPPED_ITEM_PICKUP_EPSILON,
  DROPPED_ITEM_PICKUP_RADIUS_M,
  distanceMeters,
  type DroppedItemSnapshot
} from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import {
  activeDroppedItems,
  advanceManorDroppedItemInteraction,
  advanceDroppedItemInteraction,
  canPickupDroppedItem,
  clearDroppedItemInteraction,
  distanceToDroppedItem,
  droppedItemDisplayName,
  DroppedItemPickupRequestGate,
  markDroppedItemPickupRequesting,
  manorDroppedItemSelectionCandidates,
  planDroppedItemStackPickup,
  recommendedDroppedItemPickupQuantity,
  selectDroppedItem,
  stackDroppedItemPile,
  stackDroppedItemsForWorld,
  startManorDroppedItemInteraction,
  startDroppedItemInteraction
} from "./droppedItemModel.js";

describe("dropped item model", () => {
  it("keeps only active, unexpired snapshot entries for ground-loot rendering", () => {
    const now = Date.parse("2026-07-09T12:00:00.000Z");
    expect(
      activeDroppedItems(
        [
          drop({ dropId: "active", expiresAt: "2026-07-09T12:01:00.000Z" }),
          drop({ dropId: "expired", expiresAt: "2026-07-09T11:59:00.000Z" }),
          drop({ dropId: "picked", status: "picked_up" })
        ],
        now
      ).map((item) => item.dropId)
    ).toEqual(["active"]);
  });

  it("uses the same short pickup radius as server authority", () => {
    expect(DROPPED_ITEM_PICKUP_RADIUS_M).toBe(20);
    expect(canPickupDroppedItem(20)).toBe(true);
    expect(canPickupDroppedItem(20.01)).toBe(false);
    expect(canPickupDroppedItem(null)).toBe(false);
  });

  it("reports distance and readable item names", () => {
    const item = drop({ itemId: "water", variant: "fresh", lat: 35, lon: -106 });
    expect(distanceToDroppedItem({ lat: 35, lon: -106 }, item)).toBeCloseTo(0, 5);
    expect(droppedItemDisplayName(item)).toBe("Fresh Water");
    expect(droppedItemDisplayName(drop({ itemId: "iron" }))).toBe("Iron Ore");
  });

  it("combines identical pile rows and plans item-wide or partial pickup in custody order", () => {
    const leatherOne = drop({
      dropId: "leather-1",
      itemId: "leather",
      quantity: 2,
      pileOrder: 0
    });
    const wood = drop({ dropId: "wood", quantity: 5, pileOrder: 1 });
    const leatherTwo = drop({
      dropId: "leather-2",
      itemId: "leather",
      quantity: 4,
      pileOrder: 2
    });

    const stacks = stackDroppedItemPile([leatherTwo, wood, leatherOne]);
    expect(stacks.map((stack) => [stack.displayDrop.itemId, stack.displayDrop.quantity]))
      .toEqual([["leather", 6], ["wood", 5]]);
    expect(planDroppedItemStackPickup(stacks[0]!.drops, "all")).toEqual([
      { dropId: "leather-1", intent: { mode: "all" } },
      { dropId: "leather-2", intent: { mode: "all" } }
    ]);
    expect(planDroppedItemStackPickup(stacks[0]!.drops, 5)).toEqual([
      { dropId: "leather-1", intent: { mode: "all" } },
      { dropId: "leather-2", intent: { mode: "quantity", quantity: 3 } }
    ]);
  });

  it("renders one ground stack per pile, item, and variant", () => {
    const first = drop({ dropId: "leather-1", pileId: "pile-a", quantity: 2 });
    const merged = drop({ dropId: "leather-2", pileId: "pile-a", quantity: 4 });
    const separate = drop({ dropId: "leather-3", pileId: "pile-b", quantity: 3 });

    const stacks = stackDroppedItemsForWorld([first, merged, separate]);
    expect(stacks.map((stack) => ({
      dropId: stack.displayDrop.dropId,
      quantity: stack.displayDrop.quantity,
      sourceRows: stack.drops.length
    }))).toEqual([
      { dropId: "leather-1", quantity: 6, sourceRows: 2 },
      { dropId: "leather-3", quantity: 3, sourceRows: 1 }
    ]);
  });

  it("offers co-located recovery rows from a legacy pile id without merging distinct items", () => {
    const recoveryWood = drop({
      dropId: "recovery-wood",
      pileId: "manor-storage-recovery:manor-a",
      pileOrder: 0,
      quantity: 12,
      manorId: "manor-a",
      spaceId: "manor_main_room",
      localX: 877.8,
      localY: 307.23
    });
    const recoveryEquipment = drop({
      dropId: "recovery-equipment",
      pileId: "manor-storage-recovery:manor-a",
      pileOrder: 1,
      itemId: "iron_bar",
      equipmentInstanceId: "equipment-a",
      quantity: 1,
      manorId: "manor-a",
      spaceId: "manor_main_room",
      localX: 877.8,
      localY: 307.23
    });
    const recoveryBackpack = drop({
      dropId: "recovery-backpack",
      pileId: "manor-storage-recovery:manor-a",
      pileOrder: 2,
      itemId: "starter_backpack",
      backpackInstanceId: "backpack-a",
      quantity: 1,
      manorId: "manor-a",
      spaceId: "manor_main_room",
      localX: 877.8,
      localY: 307.23
    });
    const newIron = drop({
      dropId: "new-iron",
      pileId: "drop:new-iron",
      pileOrder: 0,
      itemId: "iron",
      quantity: 3,
      manorId: "manor-a",
      spaceId: "manor_main_room",
      localX: 877.805,
      localY: 307.23
    });
    const nearbyInactive = drop({
      dropId: "picked-nearby",
      pileId: "other-pile",
      status: "picked_up",
      manorId: "manor-a",
      spaceId: "manor_main_room",
      localX: 877.8,
      localY: 307.23
    });

    const candidates = manorDroppedItemSelectionCandidates(newIron, [
      newIron,
      nearbyInactive,
      recoveryBackpack,
      recoveryEquipment,
      recoveryWood
    ]);

    expect(candidates.map((candidate) => candidate.dropId)).toEqual([
      "new-iron",
      "recovery-wood",
      "recovery-equipment",
      "recovery-backpack"
    ]);
    expect(stackDroppedItemPile(candidates).map((stack) => [
      stack.displayDrop.itemId,
      stack.displayDrop.quantity
    ])).toEqual([
      ["iron", 3],
      ["wood", 12],
      ["iron_bar", 1],
      ["starter_backpack", 1]
    ]);
  });

  it("defaults exact pickup selection to the quantity that fits remaining carry weight", () => {
    const leather = drop({ itemId: "leather", quantity: 500 });
    expect(recommendedDroppedItemPickupQuantity(leather, {
      playerId: "player-2",
      revision: 0,
      unlockedSlots: 2,
      totals: {
        wood: 250,
        stone: 0,
        coal: 0,
        iron: 0,
        sulfur: 0,
        iron_bar: 0,
        venomsteel_bar: 0,
        venomsteel_core: 0,
        fire_feather: 0, tempest_quill: 0, ice_feather: 0,
        fire_bar: 0, fire_core: 0, lightning_bar: 0, lightning_core: 0, ice_bar: 0, ice_core: 0,
        food: 0,
        ore: 0,
        water: 0,
        leather: 83,
        deer_hide: 0,
        hog_hide: 0,
        wolf_pelt: 0,
        bear_hide: 0,
        alligator_hide: 0,
        squid_flesh: 0,
        crab_carapace: 0,
        raw_meat: 0,
        shell: 0,
        giving_berry: 0,
        balsam_resin: 0,
        crude_oil: 0,
        jellyfish_venom: 0, brood_silk: 0, refined_oil: 0, raptor_scale: 0, giant_egg: 0, brood_egg: 0, clutch_egg: 0, crawler_egg: 0, broken_whistle: 0, bonewrought_blade: 0, bonewrought_mail: 0, anti_venom_tonic: 0, battle_draught: 0, ember_flask: 0, spark_tonic: 0, field_net: 0, field_trap: 0, lamp_sheath: 0, cinder_lantern: 0, challengers_lantern: 0, survey_stake_kit: 0, compass: 0, elder_acorn: 0, zephyr: 0, cave_lichen: 0, gale_plume: 0, heartsap: 0, wyrm_egg: 0, dragon_scale: 0, maw_bloom_petal: 0, giving_tree_sapling: 0, edict_seal: 0, prison_key_fragment: 0,
        crystal: 0, pearl: 0, atlas_shrine_shard: 0,
        enchantment_stone: 0
      },
      items: [
        {
          playerId: "player-2",
          resourceType: "leather",
          variant: null,
          quantity: 83,
          slotIndex: 0,
          manualSplit: false
        },
        {
          playerId: "player-2",
          resourceType: "wood",
          variant: null,
          quantity: 250,
          slotIndex: 1,
          manualSplit: false
        }
      ],
      currentWeightGrams: "58300",
      maximumWeightGrams: "100000"
    })).toBe(417);
  });

  it("allows only one pickup request until the current request finishes", () => {
    const gate = new DroppedItemPickupRequestGate();
    expect(gate.begin("drop-1")).toBe(true);
    expect(gate.begin("drop-1")).toBe(false);
    expect(gate.begin("drop-2")).toBe(false);
    expect(gate.getActiveDropId()).toBe("drop-1");
    expect(gate.finish("drop-2")).toBeNull();
    expect(gate.getActiveDropId()).toBe("drop-1");
    expect(gate.finish()).toBe("drop-1");
    expect(gate.begin("drop-2")).toBe(true);
  });

  it("selects a marker without starting movement or pickup", () => {
    expect(selectDroppedItem("drop-1")).toEqual({
      selectedDropId: "drop-1",
      interaction: null,
      command: null
    });
  });

  it("moves distant loot to a buffered point inside the shared pickup radius", () => {
    const item = dropAt("drop-1", 100);
    const transition = startDroppedItemInteraction(playerAt(0), item, { mode: "all" });

    expect(transition.interaction).toEqual({
      dropId: "drop-1",
      phase: "approaching",
      intent: { mode: "all" }
    });
    expect(transition.command?.type).toBe("move-to-range");
    if (transition.command?.type !== "move-to-range") {
      throw new Error("Expected a movement command");
    }
    expect(distanceMeters(item, transition.command.target)).toBeCloseTo(18, 1);
  });

  it("requests immediate pickup when loot is already in range", () => {
    const transition = startDroppedItemInteraction(playerAt(0), dropAt("drop-1", 19), {
      mode: "quantity",
      quantity: 2
    });

    expect(transition.interaction).toEqual({
      dropId: "drop-1",
      phase: "ready",
      intent: { mode: "quantity", quantity: 2 }
    });
    expect(transition.command).toEqual({
      type: "pickup",
      dropId: "drop-1",
      intent: { mode: "quantity", quantity: 2 }
    });
  });

  it("approaches a Manor pile and waits for an exact settled arrival before pickup", () => {
    const item = drop({
      manorId: "manor-a",
      spaceId: "manor_main_room",
      localX: 900,
      localY: 400
    });
    const started = startManorDroppedItemInteraction(
      manorAt(500, 400),
      item,
      { mode: "quantity", quantity: 2 }
    );

    expect(started.interaction).toEqual({
      dropId: item.dropId,
      phase: "approaching",
      intent: { mode: "quantity", quantity: 2 },
      manorTarget: { x: 900, y: 400 }
    });
    expect(started.command).toEqual({
      type: "move-to-manor-position",
      target: { x: 900, y: 400 }
    });
    expect(advanceManorDroppedItemInteraction(
      started.interaction!,
      manorAt(900 - MANOR_DROPPED_ITEM_PICKUP_EPSILON - 0.001, 400),
      item
    ).command).toBeNull();
    expect(advanceManorDroppedItemInteraction(
      started.interaction!,
      manorAt(900, 400, true),
      item
    ).command).toBeNull();

    const arrived = advanceManorDroppedItemInteraction(
      started.interaction!,
      manorAt(900 - MANOR_DROPPED_ITEM_PICKUP_EPSILON, 400),
      item
    );
    expect(arrived.interaction?.phase).toBe("ready");
    expect(arrived.command).toEqual({
      type: "pickup",
      dropId: item.dropId,
      intent: { mode: "quantity", quantity: 2 }
    });
  });

  it("cancels a Manor approach when the pile disappears or moves", () => {
    const item = drop({
      manorId: "manor-a",
      spaceId: "manor_main_room",
      localX: 900,
      localY: 400
    });
    const started = startManorDroppedItemInteraction(manorAt(500, 400), item, { mode: "all" });
    expect(advanceManorDroppedItemInteraction(started.interaction!, manorAt(500, 400), null))
      .toEqual({ interaction: null, command: null });
    expect(advanceManorDroppedItemInteraction(
      started.interaction!,
      manorAt(500, 400),
      { ...item, localX: 901 }
    )).toEqual({ interaction: null, command: null });
  });

  it("emits pickup exactly once after entering range despite repeated positions or snapshots", () => {
    const item = dropAt("drop-1", 100);
    const started = startDroppedItemInteraction(playerAt(0), item, { mode: "all" });
    const entered = advanceDroppedItemInteraction(started.interaction!, playerAt(81), item);

    expect(entered.command).toEqual({
      type: "pickup",
      dropId: "drop-1",
      intent: { mode: "all" }
    });
    const requesting = markDroppedItemPickupRequesting(entered.interaction!);
    expect(requesting.phase).toBe("requesting");
    expect(advanceDroppedItemInteraction(requesting, playerAt(82), item).command).toBeNull();
    expect(
      advanceDroppedItemInteraction(requesting, playerAt(82), { ...item }).command
    ).toBeNull();
  });

  it("replaces an approach with a newly selected drop", () => {
    const first = startDroppedItemInteraction(playerAt(0), dropAt("drop-1", 100), { mode: "all" });
    const second = startDroppedItemInteraction(playerAt(0), dropAt("drop-2", 160), { mode: "quantity", quantity: 1 });

    expect(first.interaction?.dropId).toBe("drop-1");
    expect(second.interaction?.dropId).toBe("drop-2");
    expect(second.command?.type).toBe("move-to-range");
  });

  it("clears approach and range-circle state when manual movement cancels loot", () => {
    const item = dropAt("drop-1", 100);
    const started = startDroppedItemInteraction(playerAt(0), item, { mode: "all" });

    expect(started.interaction?.phase).toBe("approaching");
    expect(clearDroppedItemInteraction()).toEqual({ interaction: null, command: null });
  });

  it("clears local state when a snapshot says another player removed the drop", () => {
    const item = dropAt("drop-1", 100);
    const started = startDroppedItemInteraction(playerAt(0), item, { mode: "all" });

    expect(advanceDroppedItemInteraction(started.interaction!, playerAt(0), null)).toEqual({
      interaction: null,
      command: null
    });
  });

  it("does not retry automatically after a request is rejected", () => {
    const item = dropAt("drop-1", 10);
    const requesting = markDroppedItemPickupRequesting({
      dropId: "drop-1",
      phase: "ready",
      intent: { mode: "quantity", quantity: 1 }
    });
    expect(requesting.phase).toBe("requesting");
    expect(advanceDroppedItemInteraction(requesting, playerAt(0), item).command).toBeNull();
    expect(clearDroppedItemInteraction()).toEqual({
      interaction: null,
      command: null
    });
  });

  it("never emits a harvest command or creates harvest-session state", () => {
    const outside = startDroppedItemInteraction(playerAt(0), dropAt("drop-1", 100), { mode: "all" });
    const inside = startDroppedItemInteraction(playerAt(0), dropAt("drop-1", 10), { mode: "quantity", quantity: 1 });
    const commands = [outside.command, inside.command].filter(Boolean);

    expect(commands.map((command) => command!.type)).toEqual(["move-to-range", "pickup"]);
    expect(commands.some((command) => command!.type === ("START_HARVEST" as never))).toBe(false);
    expect(outside.interaction).not.toHaveProperty("sessionId");
    expect(inside.interaction).not.toHaveProperty("completesAtMs");
  });
});

function playerAt(eastM: number): { lat: number; lon: number } {
  return { lat: 35, lon: -106 + eastM / 91_188 };
}

function manorAt(x: number, y: number, moving = false): {
  x: number;
  y: number;
  targetX: number | null;
  targetY: number | null;
  moving: boolean;
  revision: number;
} {
  return { x, y, targetX: moving ? x : null, targetY: moving ? y : null, moving, revision: 0 };
}

function dropAt(dropId: string, eastM: number): DroppedItemSnapshot {
  return drop({ dropId, ...playerAt(eastM) });
}

function drop(overrides: Partial<DroppedItemSnapshot> = {}): DroppedItemSnapshot {
  return {
    dropId: "drop-1",
    droppedBy: "player-1",
    regionCode: "NM",
    itemId: "wood",
    variant: null,
    quantity: 2,
    status: "active",
    lat: 35,
    lon: -106,
    createdAt: "2026-07-09T11:50:00.000Z",
    expiresAt: "2026-07-09T12:10:00.000Z",
    pickedUpBy: null,
    pickedUpAt: null,
    ...overrides
  };
}
